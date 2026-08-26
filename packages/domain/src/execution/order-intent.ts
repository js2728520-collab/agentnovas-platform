/**
 * 订单意图。
 *
 * 域层只产出「意图」，不产出「订单」。意图是一个纯值：它不知道交易所、
 * 不知道凭证、不知道签名，也不知道自己最终会被 paper 记账还是被真实下单。
 *
 * 平台的目标形态是真实交易 + 策略跟单，当前 Beta 只跑 paper 是阶段性限制。
 * 把这条缝维持住，GA 接入真实执行时新增一个 ExecutionPort 实现即可，域层零改动。
 * 一旦域层开始感知交易所或凭证，GA 时就得重做。
 *
 * 见 packages/domain/CLAUDE.md 与根 CLAUDE.md 的 INV-11。
 */

/** long-only：本期禁止杠杆、做空、借币、永续。 */
export type OrderSide = "buy" | "sell";

export type OrderIntentStatus =
  | "pending"     // 已生成，等待执行端取走
  | "executing"   // 执行端已认领
  | "filled"      // 完全成交
  | "partial"     // 部分成交后失效
  | "rejected"    // 被执行端或交易所拒绝
  | "expired";    // 超过有效期未成交

/**
 * 决策轮溯源。每一条意图都必须能回指产生它的那一轮七阶段决策，
 * 否则「可解释、可审计」无从谈起（INV-8）。
 */
export type IntentProvenance = {
  decisionRoundId: string;
  traceId: string;
  /**
   * 产生这条意图的策略卡代号。
   *
   * 「这一单是哪张卡做的决定」属于溯源的最基本内容——没有它，客户看不懂自己的
   * 仓位从何而来，运营也无法按策略卡熔断（ADR-0019 第 5 步）。因此是必填。
   */
  strategyCode: string;
  /** 策略卡合同哈希：同一 card/candle/contract 的重试必须幂等。 */
  contractHash: string;
  /** 形成结论所依据的已收盘 K 线标识。 */
  candleId: string;
};

export type OrderIntent = {
  id: string;
  provenance: IntentProvenance;

  /** 交易品种，例如 "BTC/USDT"。不含交易所信息。 */
  symbol: string;
  side: OrderSide;

  /**
   * 目标仓位占该组合资金的比例（0–1），而不是绝对数量。
   *
   * 跟单场景下每个客户的本金不同，绝对数量没有意义：同一条意图会扇出到 N 个
   * 组合，各自按自己的资金和 capital_pct 换算成实际下单量。换算发生在执行端，
   * 不在域层——域层不知道任何客户的余额。
   */
  targetPositionRatio: number;

  /** 可接受的入场价格区间；超出则不执行，避免滑点吃掉决策依据。 */
  entryPriceRange: { min: number; max: number };
  stopLossPrice: number;
  takeProfitPrice: number | null;

  /** 有效期。过期未成交必须作废而不是延后执行——行情已经不是决策时的行情了。 */
  validUntil: string;

  status: OrderIntentStatus;
  createdAt: string;
};

/** 域层产出意图时的入参：不含 id、状态与时间，由调用方补齐以保持纯函数。 */
export type OrderIntentDraft = Omit<OrderIntent, "id" | "status" | "createdAt">;

export class OrderIntentError extends Error {
  // 不用 TypeScript 参数属性：仓库用 node --experimental-strip-types 跑脚本与测试，
  // strip-only 模式不支持参数属性，会在运行时抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OrderIntentError";
    this.code = code;
  }
}

/**
 * 意图自洽性校验。
 *
 * 这不是风控闸门（那是独立的一层），只检查这条意图本身是否自相矛盾。
 * 不合格就抛——域层不做静默降级（INV-6 / INV-7）。
 */
export function assertValidOrderIntent(intent: OrderIntentDraft): void {
  const { symbol, side, targetPositionRatio, entryPriceRange, stopLossPrice, takeProfitPrice } = intent;

  if (!symbol.includes("/")) {
    throw new OrderIntentError("INTENT_SYMBOL_INVALID", `品种格式无效：${symbol}`);
  }
  if (!Number.isFinite(targetPositionRatio) || targetPositionRatio <= 0 || targetPositionRatio > 1) {
    throw new OrderIntentError("INTENT_RATIO_INVALID", "目标仓位比例必须落在 (0, 1]");
  }
  if (!Number.isFinite(entryPriceRange.min) || !Number.isFinite(entryPriceRange.max)
      || entryPriceRange.min <= 0 || entryPriceRange.max < entryPriceRange.min) {
    throw new OrderIntentError("INTENT_PRICE_RANGE_INVALID", "入场价格区间无效");
  }
  if (!Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
    throw new OrderIntentError("INTENT_STOP_LOSS_INVALID", "止损价必须为正数");
  }

  // long-only：买入的止损必须低于入场下限，止盈必须高于入场上限。
  // 方向写反的意图如果流到执行端，会变成「一进场就触发止损」。
  if (side === "buy") {
    if (stopLossPrice >= entryPriceRange.min) {
      throw new OrderIntentError("INTENT_STOP_LOSS_ABOVE_ENTRY", "买入意图的止损价必须低于入场价下限");
    }
    if (takeProfitPrice !== null && takeProfitPrice <= entryPriceRange.max) {
      throw new OrderIntentError("INTENT_TAKE_PROFIT_BELOW_ENTRY", "买入意图的止盈价必须高于入场价上限");
    }
  } else {
    if (stopLossPrice <= entryPriceRange.max) {
      throw new OrderIntentError("INTENT_STOP_LOSS_BELOW_EXIT", "卖出意图的止损价必须高于入场价上限");
    }
    if (takeProfitPrice !== null && takeProfitPrice >= entryPriceRange.min) {
      throw new OrderIntentError("INTENT_TAKE_PROFIT_ABOVE_EXIT", "卖出意图的止盈价必须低于入场价下限");
    }
  }
}

/** 意图是否已过有效期。时间由调用方传入，域层不读时钟（见 CLAUDE.md 规则 4）。 */
export function isOrderIntentExpired(intent: Pick<OrderIntent, "validUntil">, now: Date): boolean {
  const deadline = Date.parse(intent.validUntil);
  if (!Number.isFinite(deadline)) {
    throw new OrderIntentError("INTENT_VALID_UNTIL_INVALID", "有效期格式无效");
  }
  return now.getTime() > deadline;
}
