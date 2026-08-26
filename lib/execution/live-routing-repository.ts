/**
 * 实盘路由授权的持久化。
 *
 * 判定在 `packages/domain/src/execution/live-routing.ts`；这里落实两条不对称：
 * **开通走 maker/checker，关停单人即时。** 让系统更安全的动作永远比让系统更危险的
 * 动作容易做。
 *
 * 与熔断仓储一样，它不在 `lib/execution/server/` 里：授权表不碰任何凭证。
 */

import type { Pool, PoolClient } from "pg";

import type {
  ExchangeEnvironment,
  LiveRoutingGrant,
} from "../../packages/domain/src/execution/live-routing.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type LiveRoutingRow = {
  id: string;
  exchange: string;
  environment: ExchangeEnvironment;
  product: string;
  status: "pending" | "granted" | "revoked";
  requestedBy: string;
  requestedAt: string;
  requestNote: string;
  approvalRequestId: string | null;
  grantedBy: string | null;
  grantedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
};

/** 申请开通。此时**尚未生效**，需要另一个人批准。 */
export async function requestLiveRouting(
  database: Queryable,
  input: {
    exchange: string;
    environment: ExchangeEnvironment;
    requestedBy: string;
    note: string;
    approvalRequestId: string;
  },
): Promise<{ id: string } | { conflict: true }> {
  const exchange = input.exchange.trim().toLowerCase();
  const result = await database.query<{ id: string }>(
    `INSERT INTO execution_live_routing
       (id, exchange, environment, requested_by, request_note, approval_request_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [crypto.randomUUID(), exchange, input.environment, input.requestedBy, input.note, input.approvalRequestId],
  );
  if (!result.rows[0]) return { conflict: true };
  return { id: result.rows[0].id };
}

/**
 * 批准开通。
 *
 * `requested_by IS DISTINCT FROM $2` 是这条 SQL 的重点：发起人自己批准自己等于没有
 * maker/checker。数据库还有一条同名 CHECK 兜底——开通实盘的代价是真实资金，
 * 这条规则不该只靠一层。
 */
export async function grantLiveRouting(
  database: Queryable,
  input: { id: string; grantedBy: string; now?: Date },
): Promise<{ granted: boolean; reason?: string }> {
  const stamp = input.now?.toISOString() ?? null;
  const result = await database.query<{ id: string }>(
    `UPDATE execution_live_routing
     SET status = 'granted', granted_by = $2, granted_at = COALESCE($3::timestamptz, now())
     WHERE id = $1 AND status = 'pending' AND requested_by IS DISTINCT FROM $2
     RETURNING id`,
    [input.id, input.grantedBy, stamp],
  );
  if (result.rows[0]) return { granted: true };

  const row = (await database.query<{ status: string; requested_by: string }>(
    "SELECT status, requested_by FROM execution_live_routing WHERE id = $1", [input.id],
  )).rows[0];
  if (!row) return { granted: false, reason: "LIVE_ROUTING_REQUEST_NOT_FOUND" };
  if (row.status !== "pending") return { granted: false, reason: "LIVE_ROUTING_NOT_PENDING" };
  return { granted: false, reason: "LIVE_ROUTING_SELF_APPROVAL_FORBIDDEN" };
}

/**
 * 关停。单人即时生效，且**待批准的申请也一并关掉**。
 *
 * 关停是把风险收回来的方向，不需要第二个人同意。允许关停 pending 的申请，是因为
 * 「我们决定先不开了」不该还要走一遍批准流程。
 */
export async function revokeLiveRouting(
  database: Queryable,
  input: { id: string; revokedBy: string; reason: string; now?: Date },
): Promise<{ revoked: boolean }> {
  const stamp = input.now?.toISOString() ?? null;
  const result = await database.query<{ id: string }>(
    `UPDATE execution_live_routing
     SET status = 'revoked', revoked_by = $2, revoked_at = COALESCE($3::timestamptz, now()), revoke_reason = $4
     WHERE id = $1 AND status IN ('pending', 'granted')
     RETURNING id`,
    [input.id, input.revokedBy, stamp, input.reason],
  );
  return { revoked: result.rows.length > 0 };
}

/** 下单准入用：只返回已批准生效的授权。 */
export async function listLiveRoutingGrants(database: Queryable): Promise<LiveRoutingGrant[]> {
  const result = await database.query<{ exchange: string; environment: ExchangeEnvironment }>(
    "SELECT exchange, environment FROM execution_live_routing WHERE status = 'granted'",
  );
  return result.rows.map((row) => ({ exchange: row.exchange, environment: row.environment }));
}

export async function listLiveRouting(
  database: Queryable,
  options: { limit?: number } = {},
): Promise<LiveRoutingRow[]> {
  const result = await database.query(
    `SELECT id, exchange, environment, product, status, requested_by, requested_at,
            request_note, approval_request_id, granted_by, granted_at,
            revoked_by, revoked_at, revoke_reason
     FROM execution_live_routing
     ORDER BY requested_at DESC
     LIMIT $1`,
    [options.limit ?? 100],
  );
  return result.rows.map((row) => ({
    id: row.id,
    exchange: row.exchange,
    environment: row.environment,
    product: row.product,
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: new Date(row.requested_at).toISOString(),
    requestNote: row.request_note,
    approvalRequestId: row.approval_request_id,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at ? new Date(row.granted_at).toISOString() : null,
    revokedBy: row.revoked_by,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revokeReason: row.revoke_reason,
  }));
}
