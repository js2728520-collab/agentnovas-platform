/**
 * 熔断开关的持久化。
 *
 * 判定在 `packages/domain/src/execution/kill-switch.ts`；这里只负责存取，
 * 并把「挂上单人即时、摘除走 maker/checker」这条不对称落成两组不同的函数。
 *
 * 它**不在 `lib/execution/server/` 里**：那个目录的含义是「必须与凭证解密密钥住在
 * 同一个进程」。熔断开关不碰任何凭证，运维端要直接读写它，放进 server/ 只会逼着
 * Web 层去跨越一条为密钥划下的边界。
 */

import type { Pool, PoolClient } from "pg";

import type {
  ActiveKillSwitch,
  KillSwitchDimension,
} from "../../packages/domain/src/execution/kill-switch.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type KillSwitchRow = ActiveKillSwitch & {
  id: string;
  active: boolean;
  engagedBy: string;
  engagedAt: string;
  releaseRequestId: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
};

/**
 * 挂上熔断。单人即时生效——出事时没有时间等第二个人批准。
 *
 * 同一对象已有生效开关时不重复挂（唯一索引保证），返回既有的那条。
 * 这不是失败：两个运营同时按下同一个开关是正常的，重要的是结果只有一个。
 */
export async function engageKillSwitch(
  database: Queryable,
  input: {
    dimension: KillSwitchDimension;
    scopeValue: string;
    reason: string;
    engagedBy: string;
    now?: Date;
  },
): Promise<{ id: string; created: boolean }> {
  const stamp = input.now?.toISOString() ?? null;
  const inserted = await database.query<{ id: string }>(
    `INSERT INTO execution_kill_switches (id, dimension, scope_value, reason, engaged_by, engaged_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [crypto.randomUUID(), input.dimension, input.scopeValue, input.reason, input.engagedBy, stamp],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };

  const existing = await database.query<{ id: string }>(
    `SELECT id FROM execution_kill_switches
     WHERE dimension = $1 AND scope_value = $2 AND active`,
    [input.dimension, input.scopeValue],
  );
  if (!existing.rows[0]) throw new Error("KILL_SWITCH_ENGAGE_FAILED");
  return { id: existing.rows[0].id, created: false };
}

/** 下单准入用。只返回判定需要的字段。 */
export async function listActiveKillSwitches(database: Queryable): Promise<ActiveKillSwitch[]> {
  const result = await database.query<{ dimension: KillSwitchDimension; scope_value: string; reason: string }>(
    "SELECT dimension, scope_value, reason FROM execution_kill_switches WHERE active",
  );
  return result.rows.map((row) => ({
    dimension: row.dimension,
    scopeValue: row.scope_value,
    reason: row.reason,
  }));
}

/** 登记一条解除申请。开关**仍然生效**，直到复核通过。 */
export async function requestKillSwitchRelease(
  database: Queryable,
  input: { id: string; requestedBy: string; approvalRequestId: string; now?: Date },
): Promise<{ requested: boolean }> {
  const stamp = input.now?.toISOString() ?? null;
  const result = await database.query<{ id: string }>(
    `UPDATE execution_kill_switches
     SET release_request_id = $2, release_requested_by = $3,
         release_requested_at = COALESCE($4::timestamptz, now())
     WHERE id = $1 AND active AND release_request_id IS NULL
     RETURNING id`,
    [input.id, input.approvalRequestId, input.requestedBy, stamp],
  );
  return { requested: result.rows.length > 0 };
}

/**
 * 复核通过后真正解除。
 *
 * `releasedBy <> release_requested_by` 由调用方（路由层）校验并拒绝——
 * 发起人自己批准自己等于没有 maker/checker。这里额外用 SQL 再挡一次，
 * 因为这条规则的代价太高，不该只靠一层。
 */
export async function applyKillSwitchRelease(
  database: Queryable,
  input: { id: string; releasedBy: string; now?: Date },
): Promise<{ released: boolean; reason?: string }> {
  const stamp = input.now?.toISOString() ?? null;
  const result = await database.query<{ id: string }>(
    `UPDATE execution_kill_switches
     SET active = false, released_by = $2, released_at = COALESCE($3::timestamptz, now())
     WHERE id = $1 AND active
       AND release_request_id IS NOT NULL
       AND release_requested_by IS DISTINCT FROM $2
     RETURNING id`,
    [input.id, input.releasedBy, stamp],
  );
  if (result.rows.length > 0) return { released: true };

  // 区分三种失败，否则运营只看到「解除失败」而不知道该怎么办。
  const row = (await database.query<{ active: boolean; release_request_id: string | null; release_requested_by: string | null }>(
    "SELECT active, release_request_id, release_requested_by FROM execution_kill_switches WHERE id = $1",
    [input.id],
  )).rows[0];
  if (!row) return { released: false, reason: "KILL_SWITCH_NOT_FOUND" };
  if (!row.active) return { released: false, reason: "KILL_SWITCH_ALREADY_RELEASED" };
  if (!row.release_request_id) return { released: false, reason: "KILL_SWITCH_RELEASE_NOT_REQUESTED" };
  return { released: false, reason: "KILL_SWITCH_SELF_APPROVAL_FORBIDDEN" };
}

export async function listKillSwitches(
  database: Queryable,
  options: { activeOnly?: boolean; limit?: number } = {},
): Promise<KillSwitchRow[]> {
  const result = await database.query(
    `SELECT id, dimension, scope_value, reason, active, engaged_by, engaged_at,
            release_request_id, released_by, released_at
     FROM execution_kill_switches
     ${options.activeOnly ? "WHERE active" : ""}
     ORDER BY engaged_at DESC
     LIMIT $1`,
    [options.limit ?? 100],
  );
  return result.rows.map((row) => ({
    id: row.id,
    dimension: row.dimension,
    scopeValue: row.scope_value,
    reason: row.reason,
    active: row.active,
    engagedBy: row.engaged_by,
    engagedAt: new Date(row.engaged_at).toISOString(),
    releaseRequestId: row.release_request_id,
    releasedBy: row.released_by,
    releasedAt: row.released_at ? new Date(row.released_at).toISOString() : null,
  }));
}
