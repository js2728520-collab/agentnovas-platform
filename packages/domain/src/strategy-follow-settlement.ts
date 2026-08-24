import {
  calculateWeeklyPerformanceFee,
  splitFollowPerformanceFee,
} from "./commercial-membership-domain.ts";

/**
 * 跟单周结算（T4.3b / P-06）。
 *
 * 与官方卡的周结算共用同一套计费口径（`calculateWeeklyPerformanceFee`）：UTC 自然周、
 * 高水位线、亏损周不计费。差别只有两处，都由需求方确认：
 *
 * - **高水位线按 (客户, 策略) 各自一条**，不与该客户其它跟随合并。作者拿到的应该是自己
 *   策略真实创造的收益，不被客户跟的其它作者的亏损抵消。
 * - **费率取自跟单合同的快照**，不是「当前费率」。合同是客户当初同意的东西（INV-5）。
 *
 * 这是纯函数：不读库、不写库、不知道周边界怎么算出来的。调用方负责把事实凑齐。
 */

export type FollowSettlementInput = {
  /** 本周该跟随实现的净盈亏（已扣手续费）。 */
  weekNetPnl: string;
  /** 含本周在内的累计净盈亏。 */
  cumulativeNetPnl: string;
  /** 结算前该 (客户, 策略) 的高水位线。 */
  priorHighWaterMark: string;
  /** 来自跟单合同的快照，不是当前费率。 */
  feeBps: number;
  platformShareBps: number;
  publicationMode: "marketplace" | "self_use";
};

export type FollowSettlement = {
  weekNetPnl: string;
  cumulativeNetPnl: string;
  priorHighWaterMark: string;
  /** 结算后的高水位线：只升不降。 */
  nextHighWaterMark: string;
  eligibleProfit: string;
  lossCarry: string;
  feeBps: number;
  feeAmount: string;
  platformAmount: string;
  authorAmount: string;
  eligibleRevenue: string;
  /** 本周是否产生费用。零费用也要出结算单，否则「这周算过了吗」无从回答。 */
  hasFee: boolean;
};

const DECIMAL_UNIT = BigInt("1000000000000000000");

function maxDecimal(a: string, b: string): string {
  // 只比较不运算，交给已有的定点解析：字符串直接比大小在 "9" 与 "10" 上会错。
  const scale = (value: string) => {
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
    const units = BigInt(whole) * DECIMAL_UNIT + BigInt(fraction.padEnd(18, "0").slice(0, 18));
    return negative ? -units : units;
  };
  return scale(a) >= scale(b) ? a : b;
}

export function settleFollowWeek(input: FollowSettlementInput): FollowSettlement {
  const fee = calculateWeeklyPerformanceFee({
    weekNetPnl: input.weekNetPnl,
    cumulativeNetPnl: input.cumulativeNetPnl,
    committedHighWaterMark: input.priorHighWaterMark,
    feeBps: input.feeBps,
  });
  const split = splitFollowPerformanceFee({
    feeAmount: fee.feeAmount,
    platformShareBps: input.platformShareBps,
    publicationMode: input.publicationMode,
  });
  return {
    weekNetPnl: fee.weekNetPnl,
    cumulativeNetPnl: fee.cumulativeNetPnl,
    priorHighWaterMark: fee.committedHighWaterMark,
    // 高水位线只升不降：亏损周之后必须先补回原高点才重新计费，否则会对同一段涨幅
    // 收两次费（INV-5）。
    nextHighWaterMark: maxDecimal(fee.committedHighWaterMark, fee.cumulativeNetPnl),
    eligibleProfit: fee.eligibleProfit,
    lossCarry: fee.lossCarry,
    feeBps: input.feeBps,
    feeAmount: fee.feeAmount,
    platformAmount: split.platformAmount,
    authorAmount: split.authorAmount,
    eligibleRevenue: split.eligibleRevenue,
    hasFee: fee.feeAmount !== "0",
  };
}

/** UTC 自然周的边界。周一 00:00:00Z 起算，含头不含尾。 */
export function utcWeekBounds(instant: Date): { weekStart: string; weekEnd: string } {
  const start = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
  // getUTCDay(): 0=周日。转成周一为 0。
  const offset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - offset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { weekStart: start.toISOString(), weekEnd: end.toISOString() };
}
