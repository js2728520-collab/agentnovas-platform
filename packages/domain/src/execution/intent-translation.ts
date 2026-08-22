/**
 * 把运行时引擎产出的意图翻译成执行端口的订单意图。
 *
 * **这一层此前是缺的，而它是「执行端接进决策扇出」真正的缺口。**
 * 仓库里长期存在两个都叫「订单意图」的类型，形状完全不同：
 *
 * - 引擎产出的（`strategy-runtime-engine.ts`）：
 *   `{ idempotencyKey, mode, action, side: "long"|"short"|null, executionTiming,
 *      requestedPrice, confirmedAtCandleCloseTime }`
 *   —— 它描述的是「这一轮决定做什么」。
 *
 * - 执行端口消费的（`execution-port.ts` 的 `OrderIntent`）：
 *   `{ id, provenance, symbol, side: "buy"|"sell", targetPositionRatio,
 *      entryPriceRange, stopLossPrice, takeProfitPrice, validUntil, … }`
 *   —— 它描述的是「往交易所发什么」。
 *
 * `ExecutionPort` 是照后者设计的，而引擎从未产出过那个形状——所以
 * `createLiveExecutionPort` 一直没有调用方。缺的不是一行 `await port.execute(...)`，
 * 是这中间的翻译。
 *
 * 翻译必须是纯函数：同一轮决策重放必须得到同一条订单意图，否则
 * `deriveClientOrderId` 的幂等就失去意义（INV-8）。
 */

import { assertValidOrderIntent, type OrderIntent, type OrderIntentDraft } from "./order-intent.ts";

/** 引擎产出的意图。字段名与 strategy-runtime-engine 保持一致。 */
export type RuntimeOrderIntent = {
  idempotencyKey: string;
  action: "enter_long" | "enter_short" | "exit" | string;
  side: "long" | "short" | null;
  requestedPrice: number;
  confirmedAtCandleCloseTime: number;
};

export type TranslationContext = {
  symbol: string;
  strategyCode: string;
  decisionRoundId: string;
  traceId: string;
  contractHash: string;
  /** 该策略卡允许的单笔资金占比（0–1）。 */
  targetPositionRatio: number;
  stopLossPct: number;
  takeProfitPct: number | null;
  /**
   * 可接受的滑点带宽（百分比）。市价单成交价不会正好等于决策价，
   * 超出这个带宽就不该成交——行情已经不是决策时的行情了。
   */
  slippageTolerancePct: number;
  /** 意图有效期（毫秒）。过期未成交必须作废而不是延后执行。 */
  validForMs: number;
};

export class IntentTranslationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "IntentTranslationError";
    this.code = code;
  }
}

function assertPositive(value: number, code: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new IntentTranslationError(code, `${code}:${value}`);
  return value;
}

/**
 * 平台只做 long-only 现货：`enter_long` → 买入，`exit` → 卖出。
 *
 * `enter_short` 必须抛错而不是被静默忽略。做空在现货上无法执行，一个被悄悄丢掉的
 * 做空意图会让上层以为「这一轮没有动作」，而实际是策略要求了一个我们做不到的动作
 * ——那必须显式暴露（INV-6）。
 */
export function resolveExecutionSide(action: string): "buy" | "sell" {
  if (action === "enter_long") return "buy";
  if (action === "exit") return "sell";
  if (action === "enter_short") {
    throw new IntentTranslationError("SHORT_NOT_EXECUTABLE_ON_SPOT", "现货不支持做空意图");
  }
  throw new IntentTranslationError("UNKNOWN_RUNTIME_ACTION", `无法翻译的运行时动作：${action}`);
}

export function toExecutionOrderIntent(
  runtimeIntent: RuntimeOrderIntent,
  context: TranslationContext,
  now: Date,
): OrderIntent {
  const side = resolveExecutionSide(runtimeIntent.action);
  const price = assertPositive(runtimeIntent.requestedPrice, "REQUESTED_PRICE_INVALID");
  const tolerance = context.slippageTolerancePct;
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 100) {
    throw new IntentTranslationError("SLIPPAGE_TOLERANCE_INVALID", `滑点带宽无效：${tolerance}`);
  }

  const band = price * (tolerance / 100);
  const entryPriceRange = { min: price - band, max: price + band };

  // 止损止盈按方向计算。买入的止损在下方、止盈在上方；卖出反之。
  // 写反的意图流到执行端会变成「一进场就触发止损」，所以 assertValidOrderIntent
  // 会在下面再校验一次——这里算，那里守。
  const stopLossPct = assertPositive(context.stopLossPct, "STOP_LOSS_PCT_INVALID");
  const stopLossPrice = side === "buy"
    ? entryPriceRange.min * (1 - stopLossPct / 100)
    : entryPriceRange.max * (1 + stopLossPct / 100);
  const takeProfitPrice = context.takeProfitPct === null ? null
    : side === "buy"
      ? entryPriceRange.max * (1 + assertPositive(context.takeProfitPct, "TAKE_PROFIT_PCT_INVALID") / 100)
      : entryPriceRange.min * (1 - assertPositive(context.takeProfitPct, "TAKE_PROFIT_PCT_INVALID") / 100);

  const draft: OrderIntentDraft = {
    provenance: {
      decisionRoundId: context.decisionRoundId,
      traceId: context.traceId,
      contractHash: context.contractHash,
      strategyCode: context.strategyCode,
      // 形成结论所依据的已收盘 K 线。重放时靠它确认「是同一根 K 线的同一个结论」。
      candleId: String(runtimeIntent.confirmedAtCandleCloseTime),
    },
    symbol: context.symbol,
    side,
    targetPositionRatio: context.targetPositionRatio,
    entryPriceRange,
    stopLossPrice,
    takeProfitPrice,
    validUntil: new Date(now.getTime() + assertPositive(context.validForMs, "VALID_FOR_MS_INVALID")).toISOString(),
  };
  // 自洽性由域层既有的校验把关，不在这里重写一遍规则。
  assertValidOrderIntent(draft);

  return {
    ...draft,
    // id 由引擎的幂等键直接沿用：同一轮决策重放必须得到同一条意图，
    // 换成随机 id 会让重放产出两条不同的意图，幂等下单也就无从谈起（INV-8）。
    id: runtimeIntent.idempotencyKey,
    status: "pending",
    createdAt: now.toISOString(),
  };
}
