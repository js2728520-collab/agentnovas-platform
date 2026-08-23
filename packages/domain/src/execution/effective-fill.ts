/**
 * 一笔实盘意图「到底成没成、成了多少」的唯一判定。
 *
 * 有两份记录说同一件事，而它们可能不一致：
 *
 *   live_execution_receipts        下单响应当时说了什么。不可改写，是审计证据。
 *   execution_reconciliations      事后回交易所查证的结果。对账存在的全部理由，
 *                                  就是回执可能是错的。
 *
 * 此前没有任何代码把这两者合起来看（LIVE_EXECUTION_BLOCKERS 的
 * RECONCILED_RESULT_NOT_IN_RECEIPT）。回执不可改写是对的——改写它等于销毁证据——
 * 但「不可改写」不等于「就是事实」。缺的不是可写的回执，是一个把两份记录归一成
 * 事实的判定。
 *
 * 刻意不引入第三张表来存「修正后的回执」：三份记录只会让不一致多一种形态。
 * 事实由这个纯函数从两份原始记录推出，任何时候重算结果相同。
 */

import type { ExecutionOutcome } from "./execution-port.ts";

export type ReceiptSnapshot = {
  outcome: ExecutionOutcome;
  filledQuantity: number;
  averagePrice: number;
  feeAmount: number;
  rejectionReason: string | null;
  executedAt: string;
};

export type ReconciliationSnapshot = {
  status: "pending" | "resolved" | "escalated";
  resolvedOutcome: ExecutionOutcome | null;
  filledQuantity: number | null;
  averagePrice: number | null;
  feeAmount: number | null;
  rejectionReason: string | null;
  resolvedAt: string | null;
  /** 运维已处理的升级件。未处理的升级会一直挡住该账户开新仓。 */
  acknowledgedAt: string | null;
};

/**
 * 判定结果。
 *
 * `settled` 才可以记账。`unsettled` 表示事实尚未确定——**这时什么都不能记**，
 * 既不能记成交也不能记未成交。把「不知道」记成「没成交」正是会导致重复下单和
 * 仓位丢失的方向（INV-7 失败安全）。
 */
export type EffectiveFill =
  | {
      state: "settled";
      /** 事实取自哪一份记录。客户看到的执行说明要能讲清这一点（INV-8）。 */
      source: "receipt" | "reconciliation";
      outcome: ExecutionOutcome;
      filledQuantity: number;
      averagePrice: number;
      feeAmount: number;
      rejectionReason: string | null;
      settledAt: string;
      /** 对账推翻了回执。运营端要能把这些单挑出来看。 */
      contradictsReceipt: boolean;
    }
  | { state: "unsettled"; reason: string };

function sameFacts(receipt: ReceiptSnapshot, outcome: ExecutionOutcome, quantity: number, price: number): boolean {
  // 数量与价格用相对误差比较：两条路径上的浮点运算次数不同，
  // 完全相等是不该期待的。1e-9 远小于任何真实的成交差异。
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return receipt.outcome === outcome && close(receipt.filledQuantity, quantity) && close(receipt.averagePrice, price);
}

export function resolveEffectiveFill(
  receipt: ReceiptSnapshot,
  reconciliation: ReconciliationSnapshot | null,
): EffectiveFill {
  // 没有对账记录：回执就是事实。
  //
  // 这条不是漏网——只有真实下单才会登记对账，而没有真实下单的回执（例如被本地
  // 闸门拒绝的）本来就没有可查证的对象。
  if (!reconciliation) {
    return {
      state: "settled",
      source: "receipt",
      outcome: receipt.outcome,
      filledQuantity: receipt.filledQuantity,
      averagePrice: receipt.averagePrice,
      feeAmount: receipt.feeAmount,
      rejectionReason: receipt.rejectionReason,
      settledAt: receipt.executedAt,
      contradictsReceipt: false,
    };
  }

  if (reconciliation.status === "pending") {
    // 查证还没结束。回执此刻可能是对的，也可能不是——这正是要查的。
    return { state: "unsettled", reason: "RECONCILIATION_PENDING" };
  }

  if (reconciliation.status === "escalated") {
    // 升级件即使已被运维确认，也不代表事实已知：确认的是「人已经看过」。
    // 事实要由人在交易所侧核对后，通过一次显式结案写回 resolved。
    return { state: "unsettled", reason: "RECONCILIATION_ESCALATED" };
  }

  // 结案。此时结案事实必须是完整的——不完整就不是结案。
  const { resolvedOutcome, filledQuantity, averagePrice, feeAmount, resolvedAt } = reconciliation;
  if (resolvedOutcome === null || filledQuantity === null || averagePrice === null
      || feeAmount === null || resolvedAt === null) {
    // 不降级到回执。一条状态为 resolved 却缺字段的记录是数据损坏，
    // 而「损坏时退回另一份记录」会让损坏永远不被发现（INV-7）。
    return { state: "unsettled", reason: "RECONCILIATION_RESOLVED_INCOMPLETE" };
  }

  return {
    state: "settled",
    source: "reconciliation",
    outcome: resolvedOutcome,
    filledQuantity,
    averagePrice,
    feeAmount,
    rejectionReason: reconciliation.rejectionReason,
    settledAt: resolvedAt,
    contradictsReceipt: !sameFacts(receipt, resolvedOutcome, filledQuantity, averagePrice),
  };
}

/** 这笔判定是否产生了应该记进账本的成交。 */
export function isBookableFill(fill: EffectiveFill): boolean {
  return fill.state === "settled"
    && (fill.outcome === "filled" || fill.outcome === "partial")
    && fill.filledQuantity > 0
    && fill.averagePrice > 0;
}
