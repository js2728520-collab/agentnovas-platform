import type { Pool } from "pg";

/**
 * 市价单可接受的滑点带宽。超出这个范围就不该成交——行情已经不是决策时的行情了。
 * 与意图有效期一起，构成「决策依据仍然成立」的两个边界。
 */
const RUNTIME_SLIPPAGE_TOLERANCE_PCT = Number(process.env.RUNTIME_SLIPPAGE_TOLERANCE_PCT || 0.5);
const RUNTIME_INTENT_VALID_FOR_MS = Number(process.env.RUNTIME_INTENT_VALID_FOR_MS || 60_000);

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
import { postLiveFillsToBook } from "./live-book-posting.ts";
import { executeOrderIntent, ExecutionServiceError } from "./execution/client.ts";
import { toExecutionOrderIntent } from "../packages/domain/src/execution/intent-translation.ts";
import {
  isLiveExecutionReady,
  LIVE_EXECUTION_BLOCKERS,
} from "../packages/domain/src/execution/live-readiness.ts";
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
  // 边界断言：部署形状必须与它声称的 mode 一致。
  //
  // 原来这里是 `exchangeAccountId !== null` 就抛——第二处意外的 fail-closed。
  // 现在改成检查真正的不变量：mode 与 exchange_account_id 必须成对出现
  // （0053 的 CHECK 在数据库侧同样保证这一点，这里是同一条规则的运行时表达）。
  //
  //   live 却没绑账户  → 无法下单，每一轮都会失败，而失败原因要到执行端才看得出来
  //   非 live 却绑了账户 → 「以为在模拟、其实随时可能真下单」的前置条件
  const boundToAccount = lease.exchangeAccountId !== null;
  if (lease.platformStrategyCode !== specification.strategyCode || !lease.paperPortfolioId
      || boundToAccount !== (lease.mode === "live")) {
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
  // 实盘：先把上几轮已确定的成交落账，再读仓位。
  //
  // 顺序不能反。账本落后一轮，引擎读到的就是「还没建仓」，于是这一轮会再开一次——
  // 无限加仓正是 LIVE_POSITION_TRACKING_MISSING 描述的后果。
  //
  // 对账未决的成交不会被记（见 live-book-posting.ts），此时引擎读到的仓位是
  // 未决之前的状态。这是有意的：三层闸门里的对账未决准入会挡住新开仓，
  // 而平仓无条件放行——客户在事实未明时仍然离得了场（INV-7）。
  if (lease.mode === "live") {
    await postLiveFillsToBook(database, { deploymentId: lease.id });
  }
  const runtimeAccess = await resolveOfficialPaperRuntimeAccess(database, {
    portfolioId: lease.paperPortfolioId,
    asOf: now,
  });
  // 模拟盘与实盘读同一张仓位表——0060 之后两本账只差一个 book 维度。
  // 此前这里对 live 恒返回 null，引擎因此永远看不到自己的实盘持仓。
  //
  // shadow 保持原样不读不写：它不下单也不记账，让它去动模拟盘那本账没有意义。
  const booked = lease.mode === "paper" || lease.mode === "live";
  const position = booked
    ? await loadOfficialPaperOpenPosition(database, lease.paperPortfolioId, specification.symbol)
    : null;
  // 标记价格同样两本账都要更新：净值、回撤、日亏都建立在它上面，
  // 不更新的话实盘账的风控读数只会在成交那一刻动一下，之后行情怎么走都看不见。
  if (booked) {
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
  // 实盘下发。
  //
  // 这是决策扇出接上真实执行的那一环：Worker 只送「决定做什么」，翻译在域层
  // （intent-translation.ts），凭证解密、限流、熔断、对账登记全部发生在执行服务
  // 进程内——Worker 从头到尾不接触任何客户凭证（ADR-0019）。
  //
  // 三层闸门仍然全部在上游生效：实盘路由授权、三维度熔断、对账未决准入。
  // 这里不重复判断，只负责把意图送过去并如实记录结果。
  let liveReceipt: Awaited<ReturnType<typeof executeOrderIntent>> | null = null;
  let liveExecutionError: string | null = null;
  if (lease.mode === "live" && !completion.duplicate && evaluated.orderIntent && lease.exchangeAccountId) {
    // 唯一一道有名字的闸门。
    //
    // 那五处意外的 fail-closed（租约过滤、边界断言、requestedPrice 恒 null、
    // symbol 格式、无创建入口）已经拆掉了：实盘部署现在可以被租走、走完决策、
    // 记账、结算——全部路径都通，只在这里停下。
    //
    // 记账缺口也补上了（live-book-posting.ts）。清单上剩下的是余额核对、
    // 客户侧开通入口、以及从未对真实交易所下过一单。
    // 见 packages/domain/src/execution/live-readiness.ts。
    if (!isLiveExecutionReady()) {
      liveExecutionError = `LIVE_EXECUTION_NOT_READY:${LIVE_EXECUTION_BLOCKERS.map((b) => b.code).join(",")}`.slice(0, 160);
      return {
        status: "completed" as const,
        cycleId: completion.id,
        sequence: completion.sequence,
        duplicate: completion.duplicate,
        decision: evaluated.decision,
        demoIntentResults,
        demoIntentError,
        liveReceipt: null,
        liveExecutionError,
      };
    }
    try {
      const intent = toExecutionOrderIntent(
        evaluated.orderIntent as never,
        {
          symbol: specification.symbol,
          strategyCode: specification.strategyCode,
          decisionRoundId: cycleId,
          traceId,
          contractHash: lease.strategyVersionId,
          targetPositionRatio: specification.risk.maxAssetAllocationPct / 100,
          // 官方现货卡没有固定止损价——它们的退出由 DSL 条件驱动。
          // 但真实下单必须带一个保护性止损，否则交易所侧没有任何兜底。
          //
          // 从既有的风控预算推导：愿意为单笔承担 riskPerTradePct 的本金风险，
          // 而这笔仓位占本金 maxAssetAllocationPct，那么仓位上可承受的逆向幅度就是
          // riskPerTradePct / maxAssetAllocationPct。这不是新增一条风控规则，
          // 是把已有的那条换算到价格上。
          stopLossPct: protectiveStopLossPct(specification.risk),
          // 止盈留空：这些卡按条件离场，编一个固定止盈会在条件尚未满足时提前平仓，
          // 等于悄悄改变了策略（INV-1：风控与策略不可被旁路）。
          takeProfitPct: null,
          slippageTolerancePct: RUNTIME_SLIPPAGE_TOLERANCE_PCT,
          validForMs: RUNTIME_INTENT_VALID_FOR_MS,
        },
        now,
      );
      liveReceipt = await executeOrderIntent({
        deploymentId: lease.id,
        customerId: lease.ownerUserId,
        accountId: lease.exchangeAccountId,
        portfolioId: lease.paperPortfolioId,
        intent,
        availableCapital: await loadLivePortfolioCapital(database, lease.paperPortfolioId),
        capitalCapRatio: specification.risk.maxAssetAllocationPct / 100,
        executionProduct: "spot_usdt",
        runtimeCycleId: cycleId,
        traceId,
      });
    } catch (error) {
      // 下发失败不能让整个周期失败：决策本身已经完成并留痕，客户仍然看得到这一轮的
      // 七阶段叙述。把错误记下来，由对账任务与运维界面接手（INV-6）。
      liveExecutionError = error instanceof ExecutionServiceError
        ? `${error.code}:${error.message}`.slice(0, 160)
        : error instanceof Error ? error.message.slice(0, 160) : "live execution failed";
    }

    // 刚下发的这笔如果当场就有确定结果，本轮就落账，不等到下一轮。
    //
    // 等一轮的代价是实打实的：客户在交易大厅上要过一个周期才看得到自己的持仓，
    // 而这期间风控读数里没有这笔仓位。市价单绝大多数情况下响应即终态，
    // 没有理由把它推迟。未决的仍然会停住（见 live-book-posting.ts）。
    try {
      await postLiveFillsToBook(database, { deploymentId: lease.id });
    } catch (error) {
      // 落账失败同样不让周期失败，但必须显式记下来：账本落后一轮时引擎会读到
      // 「还没建仓」，下一轮会再开一次。这条错误是运维发现它的唯一线索。
      const detail = error instanceof Error ? error.message.slice(0, 120) : "unknown";
      liveExecutionError = `${liveExecutionError ? `${liveExecutionError};` : ""}LIVE_BOOK_POSTING_FAILED:${detail}`.slice(0, 160);
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
    liveReceipt,
    liveExecutionError,
  };
}

/**
 * 由单笔风险预算推导保护性止损百分比。
 *
 * 官方现货卡的 risk 里没有止损价，只有「单笔愿意承担多少本金风险」与「这笔仓位占
 * 多少本金」。两者相除就是仓位上可承受的逆向幅度。
 *
 * 任一参数不合法时抛错而不是套一个默认值：一个凭空来的止损价会让客户以为有保护，
 * 而那个价位与他的风控设置毫无关系（INV-6 / INV-7）。
 */
function protectiveStopLossPct(risk: { riskPerTradePct: number; maxAssetAllocationPct: number }): number {
  const { riskPerTradePct, maxAssetAllocationPct } = risk;
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0
      || !Number.isFinite(maxAssetAllocationPct) || maxAssetAllocationPct <= 0) {
    throw new Error("PROTECTIVE_STOP_LOSS_UNRESOLVABLE");
  }
  const pct = (riskPerTradePct / maxAssetAllocationPct) * 100;
  // 止损不能等于或超过 100%：那等于没有止损，还会让意图自洽性校验算出非正的价格。
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) throw new Error("PROTECTIVE_STOP_LOSS_UNRESOLVABLE");
  return pct;
}

/**
 * 该组合当前可动用的计价货币金额。
 *
 * 用 paper 组合的可用资金作为换算基准：实盘部署沿用同一个组合结构，分成口径因此
 * 不会与 paper 分叉（INV-5，见 migration 0053 的说明）。
 */
async function loadLivePortfolioCapital(database: Pool, portfolioId: string): Promise<number> {
  const row = (await database.query<{ available: string }>(
    "SELECT cash_usdt::text AS available FROM official_paper_portfolios WHERE id = $1",
    [portfolioId],
  )).rows[0];
  // 读不到资金就不猜一个数字：下单量算错的方向是「按一个不存在的余额下单」。
  if (!row) throw new Error("LIVE_PORTFOLIO_CAPITAL_UNAVAILABLE");
  const available = Number(row.available);
  if (!Number.isFinite(available) || available <= 0) throw new Error("LIVE_PORTFOLIO_CAPITAL_UNAVAILABLE");
  return available;
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
