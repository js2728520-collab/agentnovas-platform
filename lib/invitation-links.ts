/**
 * 可复用邀请链接。
 *
 * 「每人一条、不为每个客户单独创建、可以重新生成」这套语义，底层其实早就成立：
 * `employee_reusable` 用完不会被标记 used（见 migration 0040 的
 * `client_claim_registration_invitation`，它只消费 `public_pool_single_use`），
 * 而 `owner_employee_id` 会被注册时的递归 CTE 用来沿 `reports_to_user_id` 往上走，
 * 把新客户挂进整条汇报链。
 *
 * 这一层补的是三件事：一人只能有一条有效链接、重新生成即旧链接失效、以及把码
 * 拼成可以直接发出去的链接。
 *
 * **明文只在创建那一刻存在。** 库里只有 SHA-256。链接会被转发到群里、截图、贴进
 * 文档——存明文等于多一份可泄露的凭证。想要回一条链接的办法是重新生成，
 * 代价是旧链接立刻失效，而这恰好就是撤销想要的效果。
 */

import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type InvitationLinkRow = {
  id: string;
  kind: string;
  status: "active" | "used" | "revoked";
  ownerEmployeeId: string | null;
  organizationId: string | null;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

/**
 * 拼出可以直接发出去的链接。
 *
 * 走 `/login?invite=<code>` 而不是 `/register`：注册入口本来就在登录页里，
 * 单独开一个路由等于多一个要维护的页面。参数名用 `invite` 而不是 `code`，
 * 后者太泛，日志里看到 `code=` 分不清是邀请码、优惠码还是 OAuth 回调。
 */
export function buildInvitationLink(baseUrl: string, code: string): string {
  const origin = baseUrl.replace(/\/$/, "");
  return `${origin}/login?invite=${encodeURIComponent(code)}`;
}

/** 生成人类可抄写的码：去掉 0/O/1/I 这类易混字符。 */
export function generateInvitationCode(length: number): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const alphabet = `${letters}23456789`;
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return `${letters[bytes[0] % letters.length]}${
    Array.from(bytes.slice(1), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/** 某个人当前生效的可复用链接。一人最多一条，由唯一索引保证。 */
export async function findActiveReusableInvitation(
  database: Queryable,
  ownerEmployeeId: string,
): Promise<InvitationLinkRow | null> {
  const result = await database.query(
    `SELECT id, kind, status, owner_employee_id, organization_id,
            use_count, last_used_at, created_at, revoked_at
       FROM invitations
      WHERE owner_employee_id = $1 AND kind = 'employee_reusable' AND status = 'active'
      LIMIT 1`,
    [ownerEmployeeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    ownerEmployeeId: row.owner_employee_id,
    organizationId: row.organization_id,
    useCount: Number(row.use_count),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * 撤销某人当前的可复用链接。
 *
 * 重新生成必须先走这一步：唯一索引不允许同时存在两条有效链接，所以「忘了撤销旧的」
 * 会直接撞约束失败，而不是悄悄留下一条仍然有效的旧链接。
 */
export async function revokeReusableInvitation(
  database: Queryable,
  input: { ownerEmployeeId: string; revokedBy: string; now: string },
): Promise<{ revokedId: string | null }> {
  const result = await database.query<{ id: string }>(
    `UPDATE invitations
        SET status = 'revoked', revoked_at = $3, revoked_by_user_id = $2, updated_at = $3
      WHERE owner_employee_id = $1 AND kind = 'employee_reusable' AND status = 'active'
      RETURNING id`,
    [input.ownerEmployeeId, input.revokedBy, input.now],
  );
  return { revokedId: result.rows[0]?.id ?? null };
}

/** 记一次使用。可复用链接不会被标记 used，没有这个计数就无从判断链接是否外泄。 */
export async function recordInvitationUse(
  database: Queryable,
  input: { invitationId: string; now: string },
): Promise<void> {
  await database.query(
    `UPDATE invitations
        SET use_count = use_count + 1, last_used_at = $2, updated_at = $2
      WHERE id = $1 AND kind = 'employee_reusable'`,
    [input.invitationId, input.now],
  );
}
