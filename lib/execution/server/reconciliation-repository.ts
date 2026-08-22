/**
 * 对账记录的持久化与租约。
 *
 * 判定在 `packages/domain/src/execution/reconciliation.ts`（纯函数）；这里只负责
 * 存取。分开是为了让状态机能被毫秒级断言，而不必起数据库。
 */

import type { Pool, PoolClient } from "pg";

import type {
  AccountReconciliationState,
  ReconciliationDecision,
  ReconciliationRecord,
} from "../../../packages/domain/src/execution/reconciliation.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ReconciliationRow = ReconciliationRecord & {
  id: string;
  customerId: string;
  exchange: string;
};

export type EnqueueReconciliationInput = {
  clientOrderId: string;
  accountId: string;
  customerId: string;
  exchange: string;
  symbol: string;
  requestedQuantity: number;
  decisionRoundId?: string | null;
  portfolioId?: string | null;
  intentId?: string | null;
  externalOrderId?: string | null;
  /**
   * 登记时刻。默认用数据库的 now()。
   *
   * 允许显式传入不是为了测试方便，而是因为**判定用的时钟必须和记录里的时钟是同一个**：
   * 「查不到订单还能不能采信」取决于 first_seen_at 到现在有多久，而对账任务用的是
   * 自己的时钟。两个时钟各走各的，采信窗口就会算错——本地时钟慢一点就把过期订单
   * 当成新鲜的，然后把真实成交判成未下单。
   */
  now?: Date;
};

/**
 * 登记一笔待对账。
 *
 * `ON CONFLICT DO NOTHING` 配合 client_order_id 的唯一约束：同一笔下单无论被登记
 * 多少次都只有一条记录。重复登记不是异常——超时重试本来就会再次走到这里。
 */
export async function enqueueReconciliation(
  database: Queryable,
  input: EnqueueReconciliationInput,
): Promise<{ created: boolean }> {
  const stamp = input.now?.toISOString() ?? null;
  const result = await database.query<{ id: string }>(
    `INSERT INTO execution_reconciliations (
       id, client_order_id, account_id, customer_id, exchange, symbol,
       requested_quantity, decision_round_id, portfolio_id, intent_id, external_order_id,
       first_seen_at, next_attempt_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               COALESCE($12::timestamptz, now()), COALESCE($12::timestamptz, now()))
     ON CONFLICT (client_order_id) DO NOTHING
     RETURNING id`,
    [
      crypto.randomUUID(), input.clientOrderId, input.accountId, input.customerId,
      input.exchange, input.symbol, input.requestedQuantity,
      input.decisionRoundId ?? null, input.portfolioId ?? null,
      input.intentId ?? null, input.externalOrderId ?? null, stamp,
    ],
  );
  return { created: result.rows.length > 0 };
}

/**
 * 取一条到期的待对账，并加租约。
 *
 * `FOR UPDATE SKIP LOCKED` 让多个 Worker 可以并行取件而不会撞车；租约到期后
 * 未结案的记录会被别的 Worker 重新取走，避免进程崩溃后记录永远卡住。
 */
export async function leaseDueReconciliation(
  database: Queryable,
  options: { workerId: string; now: Date; leaseMs: number },
): Promise<ReconciliationRow | null> {
  const leaseUntil = new Date(options.now.getTime() + options.leaseMs);
  const result = await database.query(
    `UPDATE execution_reconciliations SET leased_by = $1, leased_until = $2
     WHERE id = (
       SELECT id FROM execution_reconciliations
       WHERE status = 'pending'
         AND next_attempt_at <= $3
         AND (leased_until IS NULL OR leased_until <= $3)
       ORDER BY next_attempt_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, client_order_id, account_id, customer_id, exchange, symbol,
               requested_quantity, attempt_count, first_seen_at`,
    [options.workerId, leaseUntil.toISOString(), options.now.toISOString()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientOrderId: row.client_order_id,
    accountId: row.account_id,
    customerId: row.customer_id,
    exchange: row.exchange,
    symbol: row.symbol,
    requestedQuantity: Number(row.requested_quantity),
    attemptCount: Number(row.attempt_count),
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
  };
}

export async function applyReconciliationDecision(
  database: Queryable,
  row: Pick<ReconciliationRow, "id">,
  decision: ReconciliationDecision,
  now: Date,
  externalOrderId: string | null = null,
): Promise<void> {
  if (decision.action === "resolve") {
    await database.query(
      `UPDATE execution_reconciliations
       SET status = 'resolved', resolved_outcome = $2, filled_quantity = $3,
           average_price = $4, rejection_reason = $5, resolved_at = $6,
           external_order_id = COALESCE($7, external_order_id),
           leased_by = NULL, leased_until = NULL
       WHERE id = $1`,
      [row.id, decision.outcome, decision.filledQuantity, decision.averagePrice,
       decision.rejectionReason, now.toISOString(), externalOrderId],
    );
    return;
  }
  if (decision.action === "escalate") {
    await database.query(
      `UPDATE execution_reconciliations
       SET status = 'escalated', escalation_reason = $2, escalated_at = $3,
           leased_by = NULL, leased_until = NULL
       WHERE id = $1`,
      [row.id, decision.reason, now.toISOString()],
    );
    return;
  }
  await database.query(
    `UPDATE execution_reconciliations
     SET attempt_count = $2, next_attempt_at = $3, leased_by = NULL, leased_until = NULL
     WHERE id = $1`,
    [row.id, decision.attemptCount, new Date(decision.nextAttemptAtMs).toISOString()],
  );
}

/**
 * 该账户的对账未决情况，供开仓准入使用。
 *
 * 只有**未被运维确认**的升级才算数：确认过的升级说明人已经看过并处理了，
 * 再挡下去等于一次故障永久冻结这个账户。
 */
export async function loadAccountReconciliationState(
  database: Queryable,
  accountId: string,
): Promise<AccountReconciliationState> {
  const result = await database.query<{ status: string; symbol: string }>(
    `SELECT status, symbol FROM execution_reconciliations
     WHERE account_id = $1
       AND (status = 'pending' OR (status = 'escalated' AND acknowledged_at IS NULL))`,
    [accountId],
  );
  return {
    hasEscalated: result.rows.some((row) => row.status === "escalated"),
    pendingSymbols: result.rows.filter((row) => row.status === "pending").map((row) => row.symbol),
  };
}

/** 运维确认已处理。动作本身由调用方写审计。 */
export async function acknowledgeReconciliationEscalation(
  database: Queryable,
  input: { clientOrderId: string; actor: string; now: Date },
): Promise<{ acknowledged: boolean }> {
  const result = await database.query<{ id: string }>(
    `UPDATE execution_reconciliations
     SET acknowledged_at = $2, acknowledged_by = $3
     WHERE client_order_id = $1 AND status = 'escalated' AND acknowledged_at IS NULL
     RETURNING id`,
    [input.clientOrderId, input.now.toISOString(), input.actor],
  );
  return { acknowledged: result.rows.length > 0 };
}
