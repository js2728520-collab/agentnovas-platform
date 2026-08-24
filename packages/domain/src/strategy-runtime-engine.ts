import {
  createStrategyLegEvaluator,
  strategyDslToRuntime,
  type StrategyCandle,
  type StrategyLegV3,
} from "./strategy-dsl.ts";
import { normalizeOfficialSpotStrategySpecification } from "./platform-strategy-v3.ts";
import {
  evaluateRuntimeCandleAdmission,
  type RuntimeCandleAdmissionInput,
} from "./runtime/market-admission.ts";

export const runtimeAgentRoles = [
  "market_data",
  "technical_analysis",
  "strategy_decision",
  "adversarial_review",
  "risk",
  "decision",
  "execution",
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
  // live 与 paper 的决策逻辑完全相同，差别只在「订单是否同时也发到交易所」。
  // 让引擎知道这个区别，是为了 orderIntent.mode 与 execution 阶段的证据能如实标注
  // 这一轮是不是实盘——客户看叙述时要能分清。
  mode: "shadow" | "paper" | "live";
  position: RuntimePosition | null;
  riskState: {
    drawdownPct: number;
    dailyLossPct: number;
    consecutiveLosses: number;
    halted: boolean;
    /**
     * 读数损坏的字段名（见 runtime/risk-state.ts）。非空表示风控状态不可信，
     * 本轮拒绝开仓。与 halted 分开表达：熔断是风控生效，读数损坏是风控失效，
     * 运营端需要能区分这两件事。
     */
    unavailableFields?: readonly string[];
  };
  /**
   * 该决策轮涉及的部署是否解析到了同一个行情源（ADR-0025）。
   *
   * 与 halted、unavailableFields 分开表达，因为它们是三件不同的事：熔断是风控生效，
   * 读数损坏是风控失效，绑定分叉是**这一轮的共享叙述本身不成立**——同一段七阶段判断
   * 会被拿去解释两份不同的行情。运营端需要能区分它们，合并成一个标志就查不出原因。
   *
   * 省略视为一致：只有查过并发现分叉才拒绝，避免调用方忘了传就静默停掉所有开仓。
   */
  sourceBinding?: { consistent: boolean };
  lastDecisionCandleCloseTime?: number | null;
  marketData: RuntimeCandleAdmissionInput;
}) {
  if (!input.deploymentId || !input.strategyVersionId) throw new Error("运行部署或策略版本标识缺失");
  const officialSpot = normalizeOfficialSpotStrategySpecification(input.dsl);
  const perpetualSpecification = officialSpot ? null : strategyDslToRuntime(input.dsl);
  const specification = officialSpot ?? perpetualSpecification!;
  if (input.candles.length < 2) throw new Error("运行周期至少需要两根完整 K 线");
  if (!input.marketData) throw new Error("运行周期缺少服务端行情时间准入");
  const quality = dataQuality(input.candles);
  if (!quality.valid) throw new Error("运行周期 K 线顺序或质量无效");
  const index = input.candles.length - 1;
  const candle = input.candles[index];
  const marketAdmission = evaluateRuntimeCandleAdmission(
    input.marketData.timeframe === specification.timeframe
      && input.marketData.latestClosedAt === candle.closeTime
      ? input.marketData
      : { ...input.marketData, latestClosedAt: Number.NaN },
  );
  const marketState = classifyMarketState(input.candles);
  const longLeg = specification.legs.long;
  const shortLeg = "short" in specification.legs ? specification.legs.short : undefined;
  const evaluatorLeg = (leg: { entry: StrategyLegV3["entry"]; exit: StrategyLegV3["exit"] }) => ({
    ...leg,
    stopLossPct: "stopLossPct" in leg ? Number(leg.stopLossPct) : 1,
    takeProfitPct: "takeProfitPct" in leg ? Number(leg.takeProfitPct) : 1,
  });
  const longEvaluator = longLeg
    ? createStrategyLegEvaluator(evaluatorLeg(longLeg), input.candles)
    : null;
  const shortEvaluator = shortLeg
    ? createStrategyLegEvaluator(evaluatorLeg(shortLeg), input.candles)
    : null;
  const longEntry = Boolean(longEvaluator?.entryAt(index));
  const shortEntry = Boolean(shortEvaluator?.entryAt(index));
  const activeEvaluator = input.position?.side === "long" ? longEvaluator : shortEvaluator;
  const dslExit = Boolean(input.position && activeEvaluator?.exitAt(index));
  let action: RuntimeAction = "hold";
  let reason = "no_signal";
  let executionTiming: "next_candle_open" | "intrabar_threshold" = "next_candle_open";
  // 参考价默认取决策所依据的那根已收盘 K 线的收盘价。
  //
  // 原来只在止损/止盈两条离场分支赋值，其余情况恒为 null——第三处意外的
  // fail-closed：翻译成执行意图时会抛 REQUESTED_PRICE_INVALID，于是任何一笔开仓
  // 都到不了交易所。
  //
  // 用收盘价是因为它就是「决策依据」本身：执行意图的价格区间存在的理由，是让行情
  // 偏离决策当时的价格太远时不要成交（避免滑点吃掉决策依据）。止损/止盈触发时另有
  // 明确的触发价，覆盖掉这个默认值。
  let requestedPrice: number | null = candle.close;

  if (input.position) {
    const leg = input.position.side === "long" ? longLeg : shortLeg;
    if (!leg) throw new Error("当前仓位方向与策略版本不一致");
    const stopLossPct = "stopLossPct" in leg ? Number(leg.stopLossPct) : null;
    const takeProfitPct = "takeProfitPct" in leg ? Number(leg.takeProfitPct) : null;
    const stopPrice = stopLossPct === null ? null : input.position.side === "long"
      ? input.position.entryPrice * (1 - stopLossPct / 100)
      : input.position.entryPrice * (1 + stopLossPct / 100);
    const takePrice = takeProfitPct === null ? null : input.position.side === "long"
      ? input.position.entryPrice * (1 + takeProfitPct / 100)
      : input.position.entryPrice * (1 - takeProfitPct / 100);
    const stopHit = stopPrice !== null && (input.position.side === "long" ? candle.low <= stopPrice : candle.high >= stopPrice);
    const takeHit = takePrice !== null && (input.position.side === "long" ? candle.high >= takePrice : candle.low <= takePrice);
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
  if (isEntry && !marketAdmission.entryAllowed) {
    rejectionReasons.push(marketAdmission.quality === "stale"
      ? "行情已陈旧，禁止新开仓"
      : "行情时间无效，禁止新开仓");
  }
  if (isEntry && input.riskState.halted) rejectionReasons.push("运行部署已触发熔断");
  // 失败安全（INV-7）：同一决策轮上的部署解析到了不同的行情源时不开新仓。
  // 允许离场——退出能力不能依赖这一判断，否则持仓客户会被卡在里面。
  if (isEntry && input.sourceBinding && !input.sourceBinding.consistent) {
    rejectionReasons.push("行情源绑定分叉，禁止新开仓");
  }
  // 失败安全（INV-7）：风控读数不可信时不开新仓。放在阈值判定之前——
  // 读数坏了就没有阈值可比，拿一个猜出来的 0 去比等于把风控关掉。
  if (isEntry && input.riskState.unavailableFields?.length) {
    rejectionReasons.push(`风控读数不可用：${input.riskState.unavailableFields.join("、")}`);
  }
  const maxDrawdownPct = specification.risk.maxDrawdownPct;
  const maxDailyLossPct = officialSpot ? officialSpot.risk.dailyLossHaltPct : perpetualSpecification!.risk.maxDailyLossPct;
  const maxConsecutiveLosses = officialSpot ? null : perpetualSpecification!.risk.maxConsecutiveLosses;
  if (isEntry && input.riskState.drawdownPct >= maxDrawdownPct) rejectionReasons.push("最大回撤边界已触发");
  if (isEntry && input.riskState.dailyLossPct >= maxDailyLossPct) rejectionReasons.push("单日亏损边界已触发");
  if (isEntry && maxConsecutiveLosses !== null && input.riskState.consecutiveLosses >= maxConsecutiveLosses) rejectionReasons.push("连续亏损边界已触发");
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
    {
      role: "market_data",
      conclusion: marketAdmission.quality === "fresh"
        ? "完整 K 线与数据质量已确认"
        : marketAdmission.quality === "stale"
          ? "完整 K 线已读取，但行情已陈旧并禁止新开仓"
          : "行情时间无效并禁止新开仓",
      evidence: {
        ...quality,
        ...marketState,
        ...marketAdmission,
        firstOpenTime: input.candles[0].openTime,
        candleCloseTime: candle.closeTime,
      },
    },
    { role: "technical_analysis", conclusion: "DSL 指标与条件树已计算", evidence: { longEntry, shortEntry, dslExit, close: candle.close } },
    { role: "strategy_decision", conclusion: `候选策略方案：${action}`, evidence: { action, reason, strategyVersionId: input.strategyVersionId } },
    { role: "adversarial_review", conclusion: objections.length ? "发现运行异议" : "未发现阻断性运行异议", evidence: { objections } },
    { role: "risk", conclusion: riskApproved ? "确定性风控允许该结论" : "确定性风控拒绝新开仓", evidence: { riskState: input.riskState, rejectionReasons } },
    {
      role: "decision",
      conclusion: riskApproved
        ? action === "hold" ? "AI 最终决策：等待" : "AI 最终决策：允许进入模拟执行"
        : "AI 最终决策：拒绝新开仓",
      evidence: { action, reason, riskApproved, rejectionReasons },
    },
    { role: "execution", conclusion: orderIntent ? "已生成影子/模拟订单意图" : "本周期未生成执行意图", evidence: { orderIntent, executionMode: input.mode } },
  ].map((event, sequence) => ({ ...event, sequence: sequence + 1, durationMs: 0, llmUsed: false }));
  return { specification, candle, marketAdmission, decision, orderIntent, events };
}
