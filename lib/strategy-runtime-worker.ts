import type { Pool } from "pg";

import { assertBetaSpotRuntimeLease } from "./beta-legacy-runtime-guard.ts";
import { resolveRuntimeExplanationRoleConfig } from "./agent-model-profiles.ts";
import {
  assessPerpetualDataQuality,
  createPerpetualMarketAdapter,
  type PerpetualExchange,
} from "./perpetual-market-adapters.ts";
import { saveMarketDataSnapshot } from "./market-data-snapshots.ts";
import { getSpotCandles } from "./market-data.ts";
import { startLeaseHeartbeat } from "./lease-heartbeat.ts";
import {
  loadOfficialPaperOpenPosition,
  markOfficialPaperPosition,
  refreshOfficialPaperRiskState,
  resolveOfficialPaperRuntimeAccess,
  settlePendingOfficialPaperOrder,
} from "./official-paper-repository.ts";
import { normalizeOfficialSpotStrategySpecification } from "../packages/domain/src/platform-strategy-v3.ts";
import { enqueuePlatformDemoIntentsForRound } from "./platform-demo-execution.ts";
import {
  applyPaperFundingRates,
  completeRuntimeExplanationJob,
  completeStrategyRuntimeCycle,
  deferStrategyRuntimeLease,
  failStrategyRuntimeLease,
  failRuntimeExplanationJob,
  leaseNextRuntimeExplanationJob,
  leaseNextStrategyDeployment,
  loadOpenPaperPosition,
  renewStrategyRuntimeLease,
  settlePendingPaperOrder,
} from "./strategy-runtime-repository.ts";
import { evaluateStrategyRuntimeCycle } from "../packages/domain/src/strategy-runtime-engine.ts";
import { strategyDslToRuntime } from "../packages/domain/src/strategy-dsl.ts";
import {
  assertRuntimeSpotCandles,
  deterministicCycleId,
  deterministicDecisionRoundId,
  nextPollAt,
  resolveFundingWindowLimit,
  selectCycleCandle,
} from "../packages/domain/src/runtime/cycle-planning.ts";
import { applyDeploymentRiskOverrides } from "../packages/domain/src/runtime/deployment-overrides.ts";
import {
  classifyExplanationFailure,
  explanationRetryDelayMs,
} from "../packages/domain/src/runtime/explanation-retry.ts";
import {
  neutralRuntimeRiskState,
  resolveRuntimeRiskState,
} from "../packages/domain/src/runtime/risk-state.ts";
import {
  isMarketSnapshotReusable,
  marketCacheKey,
} from "../packages/domain/src/runtime/market-cache.ts";
import {
  callRuntimeExplanationAgent,
  resolveRuntimeExplanationPrompt,
  validateRuntimeExplanationOutput,
} from "./runtime-explanations.ts";

export type StrategyRuntimeLease = NonNullable<Awaited<ReturnType<typeof leaseNextStrategyDeployment>>>;

type RuntimeMarketAdapter = ReturnType<typeof createPerpetualMarketAdapter>;

type RuntimeSpotMarketAdapter = {
  getCandles(input: { symbol: string; timeframe: string; limit: number }): Promise<{
    items: Array<{ openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number }>;
    provider: string;
  }>;
  getFeeSchedule(): Promise<{ makerRate: number; takerRate: number; source: string }>;
};

export type StrategyRuntimeWorkerDependencies = {
  now?: () => Date;
  createAdapter?: (exchange: PerpetualExchange) => RuntimeMarketAdapter;
  createSpotAdapter?: () => RuntimeSpotMarketAdapter;
  saveSnapshot?: typeof saveMarketDataSnapshot;
  heartbeatIntervalMs?: number;
  onHeartbeatError?: (error: unknown) => void | Promise<void>;
};

export type RuntimeExplanationWorkerDependencies = {
  now?: () => Date;
  resolveConfig?: typeof resolveRuntimeExplanationRoleConfig;
  callExplanation?: typeof callRuntimeExplanationAgent;
};

function asExchange(value: string): PerpetualExchange {
  if (value === "okx" || value === "binance" || value === "bybit") return value;
  throw new Error("运行部署绑定了不支持的永续交易所");
}

type SpotCandlePayload = Awaited<ReturnType<RuntimeSpotMarketAdapter["getCandles"]>>;

/**
 * 进程内的行情复用缓存。
 *
 * 官方现货是「每个 (客户, 策略卡) 一个部署」，各自跑决策周期。5,000 会员 × 3 张卡
 * = 15,000 个部署，而三张卡合计只有 6 种 (品种, 周期) 组合——同一份 K 线会被
 * 重复拉 2,500 次，打公开行情接口必然触发限流。
 *
 * 复用是否还有效由 packages/domain/src/runtime/market-cache.ts 判定（纯函数）：
 * 以「归属的 K 线桶」为准，新 K 线一收盘立即失效——INV-8 要求决策绑定具体的
 * 已收盘 K 线，用固定 TTL 会让决策落在上一根上。
 *
 * 同一个 key 的并发请求共享同一个 Promise，避免 15,000 个部署同时穿透缓存。
 */
const spotCandleCache = new Map<string, { fetchedAt: number; payload: Promise<SpotCandlePayload> }>();

/** 供测试与运维重置。缓存只有 6 个 key，不会无限增长。 */
export function clearSpotCandleCache() {
  spotCandleCache.clear();
}

function createPublicSpotRuntimeAdapter(now: () => Date): RuntimeSpotMarketAdapter {
  return {
    async getCandles(input) {
      const key = marketCacheKey(input.symbol, input.timeframe, input.limit);
      const current = now().getTime();
      const cached = spotCandleCache.get(key);
      if (cached && isMarketSnapshotReusable({ fetchedAt: cached.fetchedAt, now: current, timeframe: input.timeframe })) {
        return cached.payload;
      }
      const payload = (async () => {
        const result = await getSpotCandles(input.symbol, input.timeframe, input.limit);
        return { items: result.candles, provider: result.provider };
      })();
      spotCandleCache.set(key, { fetchedAt: current, payload });
      // 请求失败不能留下一个会被反复复用的坏条目。
      payload.catch(() => {
        if (spotCandleCache.get(key)?.payload === payload) spotCandleCache.delete(key);
      });
      return payload;
    },
    async getFeeSchedule() {
      return { makerRate: 0.001, takerRate: 0.001, source: "conservative_public_spot_default" };
    },
  };
}

async function processOfficialSpotRuntimeDeployment(
  database: Pool,
  lease: StrategyRuntimeLease,
  workerId: string,
  dependencies: StrategyRuntimeWorkerDependencies,
) {
  const now = dependencies.now?.() ?? new Date();
  const specification = normalizeOfficialSpotStrategySpecification(lease.specification);
  if (!specification || lease.executionProduct !== "spot_usdt") throw new Error("官方现货运行规格无效");
  if (lease.platformStrategyCode !== specification.strategyCode || !lease.paperPortfolioId || lease.exchangeAccountId !== null) {
    throw new Error("官方现货部署边界不一致");
  }
  const adapter = dependencies.createSpotAdapter?.() ?? createPublicSpotRuntimeAdapter(dependencies.now ?? (() => new Date()));
  const [market, feeSchedule] = await Promise.all([
    adapter.getCandles({ symbol: specification.symbol, timeframe: specification.timeframe, limit: 500 }),
    adapter.getFeeSchedule(),
  ]);
  assertRuntimeSpotCandles(market.items);
  if (!Number.isFinite(feeSchedule.takerRate) || feeSchedule.takerRate < 0 || feeSchedule.takerRate > 0.01) {
    throw new Error("官方现货手续费响应未通过严格校验");
  }
  const lastClose = lease.lastCandleCloseAt?.getTime() ?? null;
  const cycle = selectCycleCandle(market.items, lastClose);
  if (!cycle) {
    await deferStrategyRuntimeLease(database, {
      deploymentId: lease.id, workerId, fencingToken: lease.fencingToken,
      nextCycleAt: nextPollAt(now, false),
    });
    return { status: "waiting_for_candle" as const };
  }
  const { selected, evaluationCandles } = cycle;
  const cycleId = deterministicCycleId(lease.id, selected.closeTime);
  const decisionRoundId = deterministicDecisionRoundId({
    strategyCode: specification.strategyCode,
    symbol: specification.symbol,
    timeframe: specification.timeframe,
    candleCloseTime: selected.closeTime,
  });
  const traceId = crypto.randomUUID();
  const saveSnapshot = dependencies.saveSnapshot ?? saveMarketDataSnapshot;
  // 行情快照按决策轮存：同一张卡、同一品种、同一根 K 线是同一份数据，
  // 15,000 个部署没必要各存一行。saveMarketDataSnapshot 的
  // ON CONFLICT (source_type, source_id) 本来就是幂等的，换个 sourceId 即可共享。
  const snapshot = await saveSnapshot(database, {
    sourceType: "runtime_cycle",
    sourceId: decisionRoundId,
    exchangeAccountId: null,
    exchange: "binance",
    instrumentId: specification.symbol,
    symbol: specification.symbol,
    timeframe: specification.timeframe,
    candles: evaluationCandles,
    fundingRates: [],
    instrumentRules: { product: "spot_usdt", longOnly: true, leverageEnabled: false, shortSellingEnabled: false },
    feeSchedule: { ...feeSchedule },
    dataQuality: { valid: true, candleCount: evaluationCandles.length, provider: market.provider, fundingRequired: false },
  });

  if (lease.mode === "paper") {
    await settlePendingOfficialPaperOrder(database, {
      deploymentId: lease.id,
      fillTime: new Date(selected.openTime),
      timing: "intrabar_threshold",
      traceId: `paper-settle:${lease.id}:${selected.openTime}:threshold`,
    });
    await settlePendingOfficialPaperOrder(database, {
      deploymentId: lease.id,
      fillPrice: selected.open,
      fillTime: new Date(selected.openTime),
      timing: "next_candle_open",
      traceId: `paper-settle:${lease.id}:${selected.openTime}:open`,
    });
  }
  const runtimeAccess = await resolveOfficialPaperRuntimeAccess(database, {
    portfolioId: lease.paperPortfolioId,
    asOf: now,
  });
  const position = lease.mode === "paper"
    ? await loadOfficialPaperOpenPosition(database, lease.paperPortfolioId, specification.symbol)
    : null;
  if (lease.mode === "paper") {
    await markOfficialPaperPosition(database, {
      portfolioId: lease.paperPortfolioId,
      symbol: specification.symbol,
      markPrice: selected.close,
      markedAt: new Date(selected.closeTime),
    });
  }
  const currentRiskState = await refreshOfficialPaperRiskState(database, {
    deploymentId: lease.id,
    portfolioId: lease.paperPortfolioId,
    asOf: new Date(selected.closeTime),
  });
  const evaluationInput = {
    deploymentId: lease.id,
    strategyVersionId: lease.strategyVersionId,
    dsl: specification,
    candles: evaluationCandles,
    mode: lease.mode,
    position: position
      ? { side: "long" as const, entryPrice: position.entryPrice, quantity: position.quantity }
      : null,
    lastDecisionCandleCloseTime: lastClose,
  };

  // 阶段 5 有两半（ADR-0018）。
  //
  // 卡级：用中性风控状态算，产出的是共享决策轮——同一张卡的所有客户看同一份
  // 七阶段叙述。**绝不能带任何一个客户的风控读数**：risk 阶段的 evidence 里有
  // riskState，带上就等于把某位客户的回撤、当日亏损、熔断状态展示给其他所有人。
  const cardEvaluation = evaluateStrategyRuntimeCycle({
    ...evaluationInput,
    riskState: neutralRuntimeRiskState(),
  });

  // 组合级：用这个客户真实的风控状态与访问状态算准入。引擎是纯函数，
  // 跑两次的代价是亚毫秒级，换来的是共享单元里没有客户数据。
  const evaluated = evaluateStrategyRuntimeCycle({
    ...evaluationInput,
    riskState: {
      ...resolveRuntimeRiskState(currentRiskState),
      halted: currentRiskState.halted === true || runtimeAccess.access !== "active",
    },
  });
  const completion = await completeStrategyRuntimeCycle(database, {
    cycleId,
    deploymentId: lease.id,
    workerId,
    fencingToken: lease.fencingToken,
    candleOpenTime: new Date(selected.openTime),
    candleCloseTime: new Date(selected.closeTime),
    marketDataSnapshotId: snapshot.id,
    decision: evaluated.decision,
    orderIntent: evaluated.orderIntent,
    events: evaluated.events,
    traceId,
    startedAt: now,
    nextCycleAt: nextPollAt(now, cycle.hasBacklog),
    positionSizePct: specification.risk.maxAssetAllocationPct,
    riskPerTradePct: specification.risk.riskPerTradePct,
    symbol: specification.symbol,
    takerFeeRate: feeSchedule.takerRate,
    // 共享决策轮（ADR-0018 第 1 步：双写）。同一张卡、同一品种、同一根已收盘
    // K 线只算一次；这里先把身份传下去，读取路径仍走各部署自己的周期。
    decisionRound: {
      strategyCode: specification.strategyCode,
      timeframe: specification.timeframe,
      strategyVersionId: lease.strategyVersionId,
      // 共享轮存卡级结论与卡级七阶段叙述，不含任何客户的风控读数。
      decision: cardEvaluation.decision,
      orderIntent: cardEvaluation.orderIntent,
      events: cardEvaluation.events,
    },
  });
  let demoIntentResults: Awaited<ReturnType<typeof enqueuePlatformDemoIntentsForRound>> = [];
  let demoIntentError: string | null = null;
  if (!completion.duplicate && evaluated.orderIntent) {
    try {
      demoIntentResults = await enqueuePlatformDemoIntentsForRound(database, {
        strategyCode: specification.strategyCode,
        decisionRoundId: cycleId,
        runtimeCycleId: cycleId,
        traceId,
        symbol: specification.symbol,
        side: evaluated.orderIntent.action === "exit" ? "sell" : "buy",
        referencePrice: selected.close,
      });
    } catch (error) {
      demoIntentError = error instanceof Error ? error.message.slice(0, 160) : "Demo intent enqueue failed";
    }
  }
  if (lease.mode === "paper" && evaluated.orderIntent?.executionTiming === "intrabar_threshold") {
    await settlePendingOfficialPaperOrder(database, {
      deploymentId: lease.id,
      fillTime: new Date(selected.closeTime),
      timing: "intrabar_threshold",
      traceId,
    });
  }
  return {
    status: "completed" as const,
    cycleId: completion.id,
    sequence: completion.sequence,
    duplicate: completion.duplicate,
    decision: evaluated.decision,
    demoIntentResults,
    demoIntentError,
  };
}

export async function processLeasedStrategyRuntimeDeployment(
  database: Pool,
  lease: StrategyRuntimeLease,
  workerId: string,
  dependencies: StrategyRuntimeWorkerDependencies = {},
) {
  const now = dependencies.now?.() ?? new Date();
  assertBetaSpotRuntimeLease(lease.executionProduct);
  if (lease.executionProduct === "spot_usdt") {
    return processOfficialSpotRuntimeDeployment(database, lease, workerId, dependencies);
  }
  const exchange = asExchange(lease.exchange || "");
  // 部署级覆盖只能收紧，不能放宽（INV-1）。
  const specification = applyDeploymentRiskOverrides(strategyDslToRuntime(lease.specification), {
    positionSizePct: lease.positionSizePct,
    stopLossPct: lease.stopLossPctOverride,
  });
  const adapter = dependencies.createAdapter?.(exchange) ?? createPerpetualMarketAdapter(exchange);
  const [instrument, candles, feeSchedule] = await Promise.all([
    adapter.getInstrument({ symbol: specification.symbol }),
    adapter.getCandles({ symbol: specification.symbol, timeframe: specification.timeframe, limit: 500 }),
    adapter.getFeeSchedule({ symbol: specification.symbol }),
  ]);
  if (instrument.status !== "live") throw new Error("运行部署对应的永续合约当前不可用");
  if (candles.items.length < 2) throw new Error("运行周期缺少足够的完整 K 线");

  const lastClose = lease.lastCandleCloseAt?.getTime() ?? null;
  const cycle = selectCycleCandle(candles.items, lastClose);
  if (!cycle) {
    await deferStrategyRuntimeLease(database, {
      deploymentId: lease.id,
      workerId,
      fencingToken: lease.fencingToken,
      nextCycleAt: nextPollAt(now, false),
    });
    return { status: "waiting_for_candle" as const };
  }

  const { selected, evaluationCandles } = cycle;
  const startTime = evaluationCandles[0].openTime;
  const funding = await adapter.getFundingRates({
    symbol: specification.symbol,
    startTime,
    endTime: selected.closeTime,
    limit: resolveFundingWindowLimit({
      startTime,
      endTime: selected.closeTime,
      fundingIntervalHours: instrument.fundingIntervalHours,
    }),
  });
  const dataQuality = assessPerpetualDataQuality({
    candles: { ...candles, items: evaluationCandles },
    funding,
    timeframe: specification.timeframe,
    expectedFundingIntervalHours: instrument.fundingIntervalHours,
    feeEstimated: feeSchedule.estimated,
  });
  const cycleId = deterministicCycleId(lease.id, selected.closeTime);
  const saveSnapshot = dependencies.saveSnapshot ?? saveMarketDataSnapshot;
  const snapshot = await saveSnapshot(database, {
    sourceType: "runtime_cycle",
    sourceId: cycleId,
    exchangeAccountId: lease.exchangeAccountId,
    exchange,
    instrumentId: instrument.exchangeSymbol,
    symbol: specification.symbol,
    timeframe: specification.timeframe,
    candles: evaluationCandles,
    fundingRates: funding.items,
    instrumentRules: { ...instrument },
    feeSchedule: { ...feeSchedule },
    dataQuality: { ...dataQuality },
  });

  if (lease.mode === "paper") {
    // A crash after creating an intrabar intent must not leave it pending forever.
    await settlePendingPaperOrder(database, {
      deploymentId: lease.id,
      fillTime: new Date(selected.openTime),
      timing: "intrabar_threshold",
    });
    await settlePendingPaperOrder(database, {
      deploymentId: lease.id,
      fillPrice: selected.open,
      fillTime: new Date(selected.openTime),
      timing: "next_candle_open",
    });
    await applyPaperFundingRates(database, {
      deploymentId: lease.id,
      rates: funding.items.filter(item => item.time <= selected.closeTime),
    });
  }
  const position = lease.mode === "paper" ? await loadOpenPaperPosition(database, lease.id) : null;
  const evaluated = evaluateStrategyRuntimeCycle({
    deploymentId: lease.id,
    strategyVersionId: lease.strategyVersionId,
    dsl: specification,
    candles: evaluationCandles,
    mode: lease.mode,
    position: position ? { side: position.side, entryPrice: position.entryPrice, quantity: position.quantity } : null,
    riskState: resolveRuntimeRiskState(lease.riskState),
    lastDecisionCandleCloseTime: lastClose,
  });
  const completion = await completeStrategyRuntimeCycle(database, {
    cycleId,
    deploymentId: lease.id,
    workerId,
    fencingToken: lease.fencingToken,
    candleOpenTime: new Date(selected.openTime),
    candleCloseTime: new Date(selected.closeTime),
    marketDataSnapshotId: snapshot.id,
    decision: evaluated.decision,
    orderIntent: evaluated.orderIntent,
    events: evaluated.events,
    traceId: crypto.randomUUID(),
    startedAt: now,
    nextCycleAt: nextPollAt(now, cycle.hasBacklog),
    positionSizePct: "positionSizePct" in evaluated.specification.risk
      ? evaluated.specification.risk.positionSizePct
      : evaluated.specification.risk.maxAssetAllocationPct,
    takerFeeRate: feeSchedule.takerRate,
  });
  if (lease.mode === "paper" && evaluated.orderIntent?.executionTiming === "intrabar_threshold") {
    await settlePendingPaperOrder(database, {
      deploymentId: lease.id,
      fillTime: new Date(selected.closeTime),
      timing: "intrabar_threshold",
    });
  }
  return {
    status: "completed" as const,
    cycleId: completion.id,
    sequence: completion.sequence,
    duplicate: completion.duplicate,
    decision: evaluated.decision,
  };
}

export async function processNextStrategyRuntimeDeployment(
  database: Pool,
  input: { workerId: string; leaseSeconds?: number },
  dependencies: StrategyRuntimeWorkerDependencies = {},
) {
  const now = dependencies.now?.() ?? new Date();
  const leaseSeconds = input.leaseSeconds ?? 60;
  const lease = await leaseNextStrategyDeployment(database, {
    workerId: input.workerId,
    now,
    leaseSeconds,
  });
  if (!lease) return null;
  const stopHeartbeat = startLeaseHeartbeat({
    leaseSeconds,
    intervalMs: dependencies.heartbeatIntervalMs,
    onRenewalError: dependencies.onHeartbeatError,
    renew: () => renewStrategyRuntimeLease(database, {
      deploymentId: lease.id,
      workerId: input.workerId,
      fencingToken: lease.fencingToken,
      now: new Date(),
      leaseSeconds,
    }),
  });
  try {
    return await processLeasedStrategyRuntimeDeployment(database, lease, input.workerId, dependencies);
  } catch (error) {
    await failStrategyRuntimeLease(database, {
      deploymentId: lease.id,
      workerId: input.workerId,
      fencingToken: lease.fencingToken,
      code: "RUNTIME_CYCLE_FAILED",
      message: error instanceof Error ? error.message : "Runtime cycle failed",
      retryAt: new Date(now.getTime() + 30_000),
    });
    throw error;
  } finally {
    await stopHeartbeat();
  }
}

export async function processNextRuntimeExplanation(
  database: Pool,
  input: { workerId: string; leaseSeconds?: number },
  dependencies: RuntimeExplanationWorkerDependencies = {},
) {
  const now = dependencies.now?.() ?? new Date();
  const job = await leaseNextRuntimeExplanationJob(database, {
    workerId: input.workerId,
    now,
    leaseSeconds: input.leaseSeconds ?? 60,
  });
  if (!job) return null;
  const startedAt = Date.now();
  try {
    const resolveConfig = dependencies.resolveConfig ?? resolveRuntimeExplanationRoleConfig;
    const config = await resolveConfig(database, job.explanationRole, { revisionId: job.profileRevisionId });
    if (!config) throw new Error("运行时解释任务引用的模型修订不可用");
    const expectedPrompt = await resolveRuntimeExplanationPrompt(job.explanationRole);
    if (expectedPrompt.version !== job.promptVersion || expectedPrompt.hash !== job.promptHash) {
      throw new Error("运行时解释 Prompt 版本与任务快照不一致");
    }
    const callExplanation = dependencies.callExplanation ?? callRuntimeExplanationAgent;
    const result = await callExplanation({
      config,
      role: job.explanationRole,
      context: job.context,
    });
    const output = validateRuntimeExplanationOutput(result.output);
    await completeRuntimeExplanationJob(database, {
      jobId: job.id,
      workerId: input.workerId,
      fencingToken: job.fencingToken,
      output,
      modelName: result.modelName,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: "completed" as const,
      jobId: job.id,
      cycleId: job.cycleId,
      eventRole: job.eventRole,
      modelName: result.modelName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "运行时解释处理失败";
    const code = classifyExplanationFailure(message);
    const failure = await failRuntimeExplanationJob(database, {
      jobId: job.id,
      workerId: input.workerId,
      fencingToken: job.fencingToken,
      code,
      message,
      retryAt: new Date(now.getTime() + explanationRetryDelayMs(job.attemptCount)),
    });
    return {
      status: failure.status,
      jobId: job.id,
      cycleId: job.cycleId,
      eventRole: job.eventRole,
      errorCode: code,
    };
  }
}
