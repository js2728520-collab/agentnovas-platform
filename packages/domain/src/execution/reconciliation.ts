/**
 * 对账状态机。
 *
 * 下单响应不能当作事实。市价单可能在响应之后才成交，超时的请求可能已经到了交易所，
 * 而「以为没成交」和「以为成交了」会往相反的方向出错。**必须查单确认。**
 *
 * 这一层只做判定：给定一条待对账记录与本次观测，产出「已确认 / 稍后重试 / 升级人工」。
 * 不读时钟、不查库、不发请求（域层规则 1 与 4）。
 *
 * 贯穿本文件的一条原则来自 INV-7：**不确定的时候，不能假装确定。**
 * 尤其不能把「查不到」当成「没下单」——那会让重试变成重复下单。
 */

import { classifyFill, type NormalizedOrderState } from "./fill-accounting.ts";
import type { ExecutionOutcome } from "./execution-port.ts";

export type ReconciliationStatus = "pending" | "resolved" | "escalated";

export type ReconciliationRecord = {
  clientOrderId: string;
  accountId: string;
  symbol: string;
  /** 下单时请求的数量，用于判断部分成交。 */
  requestedQuantity: number;
  /** 已尝试对账的次数，从 0 开始。 */
  attemptCount: number;
  /** 首次进入待对账的时刻。用于判断「查不到」是否还可信。 */
  firstSeenAt: string;
};

export type ReconciliationObservation =
  /** 交易所返回了这笔订单。 */
  | { kind: "order_found"; state: NormalizedOrderState; filledQuantity: number; averagePrice: number }
  /** 交易所明确回答「没有这个 clientOrderId」。 */
  | { kind: "order_absent" }
  /** 查询本身失败：网络、限流、交易所故障。**这不等于订单不存在。** */
  | { kind: "query_failed"; reason: string };

export type ReconciliationDecision =
  | {
      action: "resolve";
      outcome: ExecutionOutcome;
      filledQuantity: number;
      averagePrice: number;
      rejectionReason: string | null;
    }
  | { action: "retry"; attemptCount: number; nextAttemptAtMs: number }
  | { action: "escalate"; reason: string };

export type ReconciliationPolicy = {
  /** 超过这个次数仍未确认就升级人工。 */
  maxAttempts: number;
  /** 退避起步毫秒数。 */
  baseDelayMs: number;
  /** 退避上限。 */
  maxDelayMs: number;
  /**
   * 「查不到订单」可以被采信的时间窗（毫秒）。
   *
   * 这是本文件最容易写错的地方：多数交易所只保留近期订单可查，更久之前的订单
   * 查不到是因为**过期了**，不是因为**不存在**。超出这个窗口后再把 `order_absent`
   * 当成「从未下单」，就会把一笔真实成交判定为未成交，然后重试——重复下单。
   * 因此窗口之外一律升级人工。
   */
  absenceTrustWindowMs: number;
};

export const DEFAULT_RECONCILIATION_POLICY: ReconciliationPolicy = {
  maxAttempts: 8,
  baseDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
  absenceTrustWindowMs: 10 * 60_000,
};

/** 指数退避。attemptCount 是已尝试次数。 */
export function reconciliationRetryDelayMs(attemptCount: number, policy = DEFAULT_RECONCILIATION_POLICY): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(attemptCount, 0));
}

/** 交易所侧已经不会再变的状态。只有终态才能结案。 */
function isTerminal(state: NormalizedOrderState): boolean {
  return state === "filled" || state === "canceled" || state === "rejected";
}

export function decideReconciliation(
  record: ReconciliationRecord,
  observation: ReconciliationObservation,
  nowMs: number,
  policy: ReconciliationPolicy = DEFAULT_RECONCILIATION_POLICY,
): ReconciliationDecision {
  const attemptCount = record.attemptCount + 1;
  const exhausted = attemptCount >= policy.maxAttempts;

  if (observation.kind === "order_found") {
    if (isTerminal(observation.state)) {
      const classification = classifyFill({
        requestedQuantity: record.requestedQuantity,
        filledQuantity: observation.filledQuantity,
        averagePrice: observation.averagePrice,
        state: observation.state,
      });
      return {
        action: "resolve",
        outcome: classification.outcome,
        filledQuantity: classification.filledQuantity,
        averagePrice: classification.averagePrice,
        rejectionReason: classification.rejectionReason,
      };
    }
    // 还在挂着（live / partially_filled）：剩余量仍可能成交，现在结案会记错仓位。
    // 一直挂着不走的单需要人来看，不能无限等下去。
    if (exhausted) {
      return { action: "escalate", reason: `ORDER_STILL_OPEN:${observation.state}` };
    }
    return { action: "retry", attemptCount, nextAttemptAtMs: nowMs + reconciliationRetryDelayMs(attemptCount, policy) };
  }

  if (observation.kind === "order_absent") {
    const age = nowMs - Date.parse(record.firstSeenAt);
    if (!Number.isFinite(age)) {
      // 时间戳损坏时不能默认「还新鲜」——那正是会导致重复下单的方向。
      return { action: "escalate", reason: "FIRST_SEEN_AT_INVALID" };
    }
    if (age <= policy.absenceTrustWindowMs) {
      // 窗口内的「查不到」可以采信为从未下单：这笔可以安全重试。
      return {
        action: "resolve",
        outcome: "rejected",
        filledQuantity: 0,
        averagePrice: 0,
        rejectionReason: "ORDER_NEVER_PLACED",
      };
    }
    // 窗口外的「查不到」很可能只是订单过期不可查。判成未下单会把真实成交当成
    // 未成交然后重试——重复下单。交给人。
    return { action: "escalate", reason: "ABSENCE_NOT_TRUSTWORTHY" };
  }

  // 查询失败：**不能推断订单状态**。重试，直到耗尽次数后升级。
  if (exhausted) {
    return { action: "escalate", reason: `QUERY_FAILED:${observation.reason}` };
  }
  return { action: "retry", attemptCount, nextAttemptAtMs: nowMs + reconciliationRetryDelayMs(attemptCount, policy) };
}

export type AccountReconciliationState = {
  /** 该账户有已升级人工、尚未处理的对账。 */
  hasEscalated: boolean;
  /** 该账户仍在待对账中的品种。 */
  pendingSymbols: readonly string[];
};

export type EntryAdmission = { allowed: boolean; reason: string | null };

/**
 * 对账未决时能不能开新仓。
 *
 * 两条不对称的规则：
 *
 * **1. 升级人工 = 该账户全面停止开新仓。** 我们已经不知道这个账户在交易所的真实
 * 仓位，继续开仓是在一个未知基础上叠加（INV-7）。
 *
 * **2. 仅仅待对账，只挡该品种。** 不确定的是那一个品种的仓位，没有理由连累其它品种。
 *
 * 平仓永远放行——本函数只回答开仓。这与引擎里
 * `riskApproved = action === "exit" || …` 是同一条原则：
 * **退出能力不依赖任何一层在线**。把平仓也挡住，等于客户在最需要离场的时候离不了。
 */
export function admitNewEntry(
  state: AccountReconciliationState,
  symbol: string,
): EntryAdmission {
  if (state.hasEscalated) {
    return { allowed: false, reason: "RECONCILIATION_ESCALATED" };
  }
  if (state.pendingSymbols.includes(symbol)) {
    return { allowed: false, reason: "RECONCILIATION_PENDING_FOR_SYMBOL" };
  }
  return { allowed: true, reason: null };
}
