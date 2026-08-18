import {
  createStrategyLegEvaluator,
  strategyDslToRuntime,
  type StrategyCandle,
} from "./strategy-dsl.ts";

export const runtimeAgentRoles = [
  "market_data",
  "technical_analysis",
  "strategy_decision",
  "adversarial_review",
  "risk",
  "execution",
  "audit",
] as const;

type RuntimeAction = "enter_long" | "enter_short" | "exit" | "hold";

export type RuntimePosition = {
  side: "long" | "short";
  entryPrice: number;
  quantity: number;
};

function dataQuality(candles: StrategyCandle[]) {
  let gapsOrDuplicates = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].openTime <= candles[index - 1].openTime) gapsOrDuplicates += 1;
  }
  return { valid: candles.length >= 2 && gapsOrDuplicates === 0, candleCount: candles.length, gapsOrDuplicates };
}

function classifyMarketState(candles: StrategyCandle[]) {
  const sample = candles.slice(-20);
  const first = sample[0];
  const latest = sample.at(-1)!;
  const returnPct = first.close > 0 ? (latest.close - first.close) / first.close * 100 : 0;
  const averageRangePct = sample.reduce((sum, candle) => (
    sum + (candle.close > 0 ? (candle.high - candle.low) / candle.close * 100 : 0)
  ), 0) / sample.length;
  const state = averageRangePct >= 4
    ? "high_volatility"
    : returnPct >= 2
      ? "trend_up"
      : returnPct <= -2
        ? "trend_down"
        : "range";
  return { marketState: state, sampleSize: sample.length, returnPct, averageRangePct };
}

export function evaluateStrategyRuntimeCycle(input: {
  deploymentId: string;
  strategyVersionId: string;
  dsl: unknown;
  candles: StrategyCandle[];
  mode: "shadow" | "paper";
  position: RuntimePosition | null;
  riskState: {
    drawdownPct: number;
    dailyLossPct: number;
    consecutiveLosses: number;
    halted: boolean;
  };
  lastDecisionCandleCloseTime?: number | null;
}) {
  if (!input.deploymentId || !input.strategyVersionId) throw new Error("运行部署或策略版本标识缺失");
  const specification = strategyDslToRuntime(input.dsl);
  if (input.candles.length < 2) throw new Error("运行周期至少需要两根完整 K 线");
  const quality = dataQuality(input.candles);
  if (!quality.valid) throw new Error("运行周期 K 线顺序或质量无效");
  const index = input.candles.length - 1;
  const candle = input.candles[index];
  const marketState = classifyMarketState(input.candles);
  const longEvaluator = specification.legs.long
    ? createStrategyLegEvaluator(specification.legs.long, input.candles)
    : null;
  const shortEvaluator = specification.legs.short
    ? createStrategyLegEvaluator(specification.legs.short, input.candles)
    : null;
  const longEntry = Boolean(longEvaluator?.entryAt(index));
  const shortEntry = Boolean(shortEvaluator?.entryAt(index));
  const activeEvaluator = input.position?.side === "long" ? longEvaluator : shortEvaluator;
  const dslExit = Boolean(input.position && activeEvaluator?.exitAt(index));
  let action: RuntimeAction = "hold";
  let reason = "no_signal";
  let executionTiming: "next_candle_open" | "intrabar_threshold" = "next_candle_open";
  let requestedPrice: number | null = null;

  if (input.position) {
    const leg = input.position.side === "long" ? specification.legs.long : specification.legs.short;
    if (!leg) throw new Error("当前仓位方向与策略版本不一致");
    const stopPrice = input.position.side === "long"
      ? input.position.entryPrice * (1 - leg.stopLossPct / 100)
      : input.position.entryPrice * (1 + leg.stopLossPct / 100);
    const takePrice = input.position.side === "long"
      ? input.position.entryPrice * (1 + leg.takeProfitPct / 100)
      : input.position.entryPrice * (1 - leg.takeProfitPct / 100);
    const stopHit = input.position.side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice;
    const takeHit = input.position.side === "long" ? candle.high >= takePrice : candle.low <= takePrice;
    if (stopHit) {
      action = "exit";
      reason = "stop_loss";
      executionTiming = "intrabar_threshold";
      requestedPrice = stopPrice;
    } else if (takeHit) {
      action = "exit";
      reason = "take_profit";
      executionTiming = "intrabar_threshold";
      requestedPrice = takePrice;
    } else if (dslExit) {
      action = "exit";
      reason = "dsl_exit";
    } else {
      reason = "position_held";
    }
  } else if (longEntry && shortEntry) {
    reason = "conflicting_entry_signals";
  } else if (longEntry) {
    action = "enter_long";
    reason = "dsl_entry";
  } else if (shortEntry) {
    action = "enter_short";
    reason = "dsl_entry";
  }

  const objections: string[] = [];
  if (input.lastDecisionCandleCloseTime === candle.closeTime) objections.push("duplicate_candle_signal");
  if (longEntry && shortEntry) objections.push("conflicting_long_short_signal");
  const rejectionReasons: string[] = [];
  const isEntry = action === "enter_long" || action === "enter_short";
  if (isEntry && input.riskState.halted) rejectionReasons.push("运行部署已触发熔断");
  if (isEntry && input.riskState.drawdownPct >= specification.risk.maxDrawdownPct) rejectionReasons.push("最大回撤边界已触发");
  if (isEntry && input.riskState.dailyLossPct >= specification.risk.maxDailyLossPct) rejectionReasons.push("单日亏损边界已触发");
  if (isEntry && input.riskState.consecutiveLosses >= specification.risk.maxConsecutiveLosses) rejectionReasons.push("连续亏损边界已触发");
  if (isEntry && objections.includes("duplicate_candle_signal")) rejectionReasons.push("该完整 K 线已处理");
  const riskApproved = action === "exit" || action === "hold" || rejectionReasons.length === 0;
  const decision = { action, reason, riskApproved, rejectionReasons };
  const orderIntent = action !== "hold" && riskApproved ? {
    idempotencyKey: `${input.deploymentId}:${candle.closeTime}:${action}`,
    mode: input.mode,
    action,
    side: action === "enter_short" ? "short" : action === "enter_long" ? "long" : input.position?.side ?? null,
    executionTiming,
    requestedPrice,
    confirmedAtCandleCloseTime: candle.closeTime,
  } : null;
  const events = [
    { role: "market_data", conclusion: "完整 K 线与数据质量已确认", evidence: { ...quality, ...marketState, firstOpenTime: input.candles[0].openTime, candleCloseTime: candle.closeTime } },
    { role: "technical_analysis", conclusion: "DSL 指标与条件树已计算", evidence: { longEntry, shortEntry, dslExit, close: candle.close } },
    { role: "strategy_decision", conclusion: `固定策略版本结论：${action}`, evidence: { action, reason, strategyVersionId: input.strategyVersionId } },
    { role: "adversarial_review", conclusion: objections.length ? "发现运行异议" : "未发现阻断性运行异议", evidence: { objections } },
    { role: "risk", conclusion: riskApproved ? "确定性风控允许该结论" : "确定性风控拒绝新开仓", evidence: { riskState: input.riskState, rejectionReasons } },
    { role: "execution", conclusion: orderIntent ? "已生成幂等订单意图" : "本周期不生成订单意图", evidence: { orderIntent } },
    { role: "audit", conclusion: "周期输入、版本与七角色输出已形成审计记录", evidence: { deploymentId: input.deploymentId, strategyVersionId: input.strategyVersionId, candleCloseTime: candle.closeTime } },
  ].map((event, sequence) => ({ ...event, sequence: sequence + 1, durationMs: 0, llmUsed: false }));
  return { specification, candle, decision, orderIntent, events };
}
