/**
 * 成交回执的判定。
 *
 * 市价单也会部分成交：深度不够、单子太大、交易所撮合到一半就没量了。
 * **部分成交绝不能记成完全成交**——后续的仓位、止损数量、绩效结算、高水位线
 * 全部以回执为准。把 0.7 记成 1.0，止损时会去卖一个不存在的 0.3，
 * 而绩效分成会按一个客户从未持有的仓位计费。
 *
 * 这一层是纯判定：给定「要了多少」和「交易所说成交了多少」，产出 outcome。
 * 不读时钟、不查库、不做任何补齐。数据不合格就抛（INV-6 / INV-7）。
 */

import type { ExecutionOutcome } from "./execution-port.ts";

/** 交易所订单状态的归一化形态。各家字段名不同，适配器负责映射到这几个值。 */
export type NormalizedOrderState = "live" | "partially_filled" | "filled" | "canceled" | "rejected";

export type FillClassificationInput = {
  requestedQuantity: number;
  filledQuantity: number;
  /** 成交均价。未成交时可以是 0。 */
  averagePrice: number;
  state: NormalizedOrderState;
  /**
   * 允许的数量误差（绝对值，计价单位与数量一致）。
   *
   * 默认 0：不容忍任何缺口。交易所的最小下单单位会让实际成交量比请求量略少，
   * 这时把它判成 partial 是**安全方向**——回执如实反映拿到了多少，
   * 后续都按实际数量算。只有当调用方明确知道某个交易所的步进规则时，
   * 才应显式传入容差，而不是让一个默认值悄悄把缺口抹掉。
   */
  quantityTolerance?: number;
};

export type FillClassification = {
  outcome: ExecutionOutcome;
  filledQuantity: number;
  averagePrice: number;
  rejectionReason: string | null;
};

function assertFinite(value: number, code: string): number {
  if (!Number.isFinite(value)) throw new Error(code);
  return value;
}

export function classifyFill(input: FillClassificationInput): FillClassification {
  const requested = assertFinite(input.requestedQuantity, "FILL_REQUESTED_QUANTITY_INVALID");
  const filled = assertFinite(input.filledQuantity, "FILL_QUANTITY_INVALID");
  const tolerance = input.quantityTolerance ?? 0;
  if (requested <= 0) throw new Error("FILL_REQUESTED_QUANTITY_INVALID");
  if (filled < 0) throw new Error("FILL_QUANTITY_INVALID");
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("FILL_TOLERANCE_INVALID");

  if (filled === 0) {
    // 零成交必须给出原因。INV-6：失败要显式可见，不允许一个空的 rejected 回执
    // 让运营去猜是被拒了、撤了、还是根本没发出去。
    const reason = input.state === "rejected" ? "EXCHANGE_REJECTED"
      : input.state === "canceled" ? "EXCHANGE_CANCELED"
      : input.state === "live" ? "NOT_FILLED_YET"
      : "NO_FILL_REPORTED";
    return { outcome: "rejected", filledQuantity: 0, averagePrice: 0, rejectionReason: reason };
  }

  // 有成交就必须有正的均价。缺了它这条回执无法结算，补一个默认价等于伪造成交价。
  const price = assertFinite(input.averagePrice, "FILL_AVERAGE_PRICE_INVALID");
  if (price <= 0) throw new Error("FILL_AVERAGE_PRICE_INVALID");

  // 成交量超过请求量：可能是交易所的步进向上取整。如实记录，判为 filled。
  if (filled >= requested - tolerance) {
    return { outcome: "filled", filledQuantity: filled, averagePrice: price, rejectionReason: null };
  }

  // 缺口超过容差 —— partial。**这里不做任何向上取整。**
  return { outcome: "partial", filledQuantity: filled, averagePrice: price, rejectionReason: null };
}

/**
 * 部分成交后仍在挂的量。
 *
 * 用于对账与撤单：`partial` 的订单如果还是 live，剩余量仍可能成交，
 * 回执不是终态。执行端据此决定撤单还是等待（第 4 步的对账任务会用到）。
 */
export function unfilledRemainder(input: Pick<FillClassificationInput, "requestedQuantity" | "filledQuantity">): number {
  const remainder = input.requestedQuantity - input.filledQuantity;
  if (remainder <= 0) return 0;
  // 二进制浮点会让 1 - 0.7 得到 0.30000000000000004。这个数会被当成撤单/补单的
  // 数量发给交易所，而交易所按品种的精度校验，多出来的尾数会让整笔请求被拒。
  // 与仓库其它金额/数量计算一致，收敛到 8 位小数。
  return Number(remainder.toFixed(8));
}
