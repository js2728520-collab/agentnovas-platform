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

function safeRiskState(value: Record<string, unknown>) {
  const drawdownPct = Number(value.drawdownPct || 0);
  const dailyLossPct = Number(value.dailyLossPct || 0);
  const consecutiveLosses = Number(value.consecutiveLosses || 0);
  return {
    drawdownPct: Number.isFinite(drawdownPct) ? Math.max(drawdownPct, 0) : 0,
    dailyLossPct: Number.isFinite(dailyLossPct) ? Math.max(dailyLossPct, 0) : 0,
    consecutiveLosses: Number.isInteger(consecutiveLosses) ? Math.max(consecutiveLosses, 0) : 0,
    halted: value.halted === true,
  };
}

function deterministicCycleId(deploymentId: string, candleCloseTime: number) {
  return `runtime:${deploymentId}:${candleCloseTime}`;
}

function nextPollAt(now: Date, hasBacklog: boolean) {
  return new Date(now.getTime() + (hasBacklog ? 1_000 : 15_000));
}

function createPublicSpotRuntimeAdapter(): RuntimeSpotMarketAdapter {
  return {
    async getCandles(input) {
      const result = await getSpotCandles(input.symbol, input.timeframe, input.limit);
      return { items: result.candles, provider: result.provider };
    },
    async getFeeSchedule() {
      return { makerRate: 0.001, takerRate: 0.001, source: "conservative_public_spot_default" };
    },
  };
}

function assertSpotCandles(candles: Awaited<ReturnType<RuntimeSpotMarketAdapter["getCandles"]>>["items"]) {
  if (candles.length < 2) throw new Error("官方现货运行周期缺少足够的完整 K 线");
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!Object.values(candle).every(Number.isFinite)
      || candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0
      || candle.openTime >= candle.closeTime
      || (index > 0 && candle.openTime <= candles[index - 1].openTime)) {
      throw new Error("官方现货行情响应未通过严格校验");
    }
  }
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
  const adapter = dependencies.createSpotAdapter?.() ?? createPublicSpotRuntimeAdapter();
  const [market, feeSchedule] = await Promise.all([
    adapter.getCandles({ symbol: specification.symbol, timeframe: specification.timeframe, limit: 500 }),
    adapter.getFeeSchedule(),
  ]);
  assertSpotCandles(market.items);
  if (!Number.isFinite(feeSchedule.takerRate) || feeSchedule.takerRate < 0 || feeSchedule.takerRate > 0.01) {
    throw new Error("官方现货手续费响应未通过严格校验");
  }
  const lastClose = lease.lastCandleCloseAt?.getTime() ?? null;
  const selected = lastClose === null
    ? market.items.at(-1)
    : market.items.find((candle) => candle.closeTime > lastClose);
  if (!selected) {
    await deferStrategyRuntimeLease(database, {
      deploymentId: lease.id, workerId, fencingToken: lease.fencingToken,
      nextCycleAt: nextPollAt(now, false),
    });
    return { status: "waiting_for_candle" as const };
  }
  const selectedIndex = market.items.findIndex((candle) => candle.closeTime === selected.closeTime);
  const evaluationCandles = market.items.slice(0, selectedIndex + 1);
  const cycleId = deterministicCycleId(lease.id, selected.closeTime);
  const traceId = crypto.randomUUID();
  const saveSnapshot = dependencies.saveSnapshot ?? saveMarketDataSnapshot;
  const snapshot = await saveSnapshot(database, {
    sourceType: "runtime_cycle",
    sourceId: cycleId,
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
  const evaluated = evaluateStrategyRuntimeCycle({
    deploymentId: lease.id,
    strategyVersionId: lease.strategyVersionId,
    dsl: specification,
    candles: evaluationCandles,
    mode: lease.mode,
    position: position ? { side: "long", entryPrice: position.entryPrice, quantity: position.quantity } : null,
    riskState: {
      ...safeRiskState(currentRiskState),
      halted: currentRiskState.halted === true || runtimeAccess.access !== "active",
    },
    lastDecisionCandleCloseTime: lastClose,
  });
  const hasBacklog = selected.closeTime < market.items.at(-1)!.closeTime;
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
    nextCycleAt: nextPollAt(now, hasBacklog),
    positionSizePct: specification.risk.maxAssetAllocationPct,
    riskPerTradePct: specification.risk.riskPerTradePct,
    symbol: specification.symbol,
    takerFeeRate: feeSchedule.takerRate,
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
  const baseSpecification = strategyDslToRuntime(lease.specification);
  const positionSizePct = lease.positionSizePct === null
    ? baseSpecification.risk.positionSizePct
    : Math.min(baseSpecification.risk.positionSizePct, lease.positionSizePct);
  const stopLossOverride = lease.stopLossPctOverride;
  const specification = {
    ...baseSpecification,
    legs: {
      ...(baseSpecification.legs.long ? {
        long: {
          ...baseSpecification.legs.long,
          stopLossPct: stopLossOverride === null
            ? baseSpecification.legs.long.stopLossPct
            : Math.min(baseSpecification.legs.long.stopLossPct, stopLossOverride),
        },
      } : {}),
      ...(baseSpecification.legs.short ? {
        short: {
          ...baseSpecification.legs.short,
          stopLossPct: stopLossOverride === null
            ? baseSpecification.legs.short.stopLossPct
            : Math.min(baseSpecification.legs.short.stopLossPct, stopLossOverride),
        },
      } : {}),
    },
    risk: { ...baseSpecification.risk, positionSizePct },
  };
  const adapter = dependencies.createAdapter?.(exchange) ?? createPerpetualMarketAdapter(exchange);
  const [instrument, candles, feeSchedule] = await Promise.all([
    adapter.getInstrument({ symbol: specification.symbol }),
    adapter.getCandles({ symbol: specification.symbol, timeframe: specification.timeframe, limit: 500 }),
    adapter.getFeeSchedule({ symbol: specification.symbol }),
  ]);
  if (instrument.status !== "live") throw new Error("运行部署对应的永续合约当前不可用");
  if (candles.items.length < 2) throw new Error("运行周期缺少足够的完整 K 线");

  const lastClose = lease.lastCandleCloseAt?.getTime() ?? null;
  const selected = lastClose === null
    ? candles.items.at(-1)
    : candles.items.find(candle => candle.closeTime > lastClose);
  if (!selected) {
    await deferStrategyRuntimeLease(database, {
      deploymentId: lease.id,
      workerId,
      fencingToken: lease.fencingToken,
      nextCycleAt: nextPollAt(now, false),
    });
    return { status: "waiting_for_candle" as const };
  }

  const selectedIndex = candles.items.findIndex(candle => candle.closeTime === selected.closeTime);
  const evaluationCandles = candles.items.slice(0, selectedIndex + 1);
  const startTime = evaluationCandles[0].openTime;
  const fundingLimit = Math.min(
    Math.ceil((selected.closeTime - startTime) / (instrument.fundingIntervalHours * 3_600_000)) + 10,
    10_000,
  );
  const funding = await adapter.getFundingRates({
    symbol: specification.symbol,
    startTime,
    endTime: selected.closeTime,
    limit: Math.max(fundingLimit, 1),
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
    riskState: safeRiskState(lease.riskState),
    lastDecisionCandleCloseTime: lastClose,
  });
  const hasBacklog = selected.closeTime < candles.items.at(-1)!.closeTime;
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
    nextCycleAt: nextPollAt(now, hasBacklog),
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
    const code = /超时/.test(message)
      ? "RUNTIME_EXPLANATION_TIMEOUT"
      : /Prompt 版本/.test(message)
        ? "RUNTIME_EXPLANATION_PROMPT_MISMATCH"
        : "RUNTIME_EXPLANATION_FAILED";
    const failure = await failRuntimeExplanationJob(database, {
      jobId: job.id,
      workerId: input.workerId,
      fencingToken: job.fencingToken,
      code,
      message,
      retryAt: new Date(now.getTime() + Math.min(5 * 60_000, 15_000 * 2 ** Math.max(job.attemptCount - 1, 0))),
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
