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

/** 员工邀请链接的有效期。48 小时，运维可通过环境变量收紧但不能放宽到无限。 */
export const STAFF_INVITATION_TTL_MS = 48 * 3600_000;

/**
 * 员工链接与客户链接的区别不在能不能复用，而在**有效期与审批**。
 *
 * 拿到客户链接的人最多注册成一个客户，只能看到自己的数据；拿到员工链接的人会进入
 * 组织架构，能看到名下客户的资料、发起充值人工操作、调整归属。同一条链接永久有效
 * 意味着一次转发就是永久的入口。
 *
 * 48 小时把窗口收窄；真正的闸门仍是双人复核——即使链接在窗口内外泄，多出来的账号
 * 也只能停在待批准状态。期限的作用是把复核人要审的量控制住。
 */
export function staffInvitationExpiry(now: Date, ttlMs = STAFF_INVITATION_TTL_MS): string {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > STAFF_INVITATION_TTL_MS) {
    // 只允许收紧，不允许放宽。一个能被配置成无限的期限等于没有期限。
    throw new Error("STAFF_INVITATION_TTL_INVALID");
  }
  return new Date(now.getTime() + ttlMs).toISOString();
}

/** 链接是否仍在有效期内。过期判定放在这里，调用方不各自比时间。 */
export function isStaffInvitationUsable(
  invitation: { status: string; expiresAt: string | null },
  now: Date,
): { usable: boolean; reason: string | null } {
  if (invitation.status !== "active") return { usable: false, reason: "STAFF_LINK_NOT_ACTIVE" };
  if (!invitation.expiresAt) return { usable: false, reason: "STAFF_LINK_MISSING_EXPIRY" };
  const deadline = Date.parse(invitation.expiresAt);
  // 时间戳损坏时判为不可用：默认放行才是危险的方向。
  if (!Number.isFinite(deadline)) return { usable: false, reason: "STAFF_LINK_EXPIRY_INVALID" };
  if (now.getTime() > deadline) return { usable: false, reason: "STAFF_LINK_EXPIRED" };
  return { usable: true, reason: null };
}

/**
 * 员工邀请链接。指向目标角色所属的端，不是生成链接的人所在的端。
 *
 * 技术人员进运维端，其余进运营端。发错端会让人登进一个自己没有任何权限的应用
 * ——页面打得开，点哪里都是 AccessDenied，而原因完全看不出来。
 */
export function buildStaffInvitationLink(
  baseUrl: string,
  code: string,
  audience: "operations" | "maintenance",
): string {
  const origin = baseUrl.replace(/\/$/, "");
  return `${origin}/login?staff-invite=${encodeURIComponent(code)}&app=${audience}`;
}

/** 生成人类可抄写的码：去掉 0/O/1/I 这类易混字符。 */
export function generateInvitationCode(length: number): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const alphabet = `${letters}23456789`;
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return `${letters[bytes[0] % letters.length]}${
    Array.from(bytes.slice(1), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/**
 * 员工邀请链接的落库形态。与客户链接共用一张表，靠 kind 区分。
 *
 * 用同一张表而不是新开一张：两者的核心字段（归属人、状态、使用计数、撤销记录）
 * 完全相同，拆开会让「这个人有哪些链接」变成两次查询和两套撤销逻辑。
 */
export type StaffInvitationRow = InvitationLinkRow & {
  expiresAt: string | null;
  targetRole: string | null;
};

export async function findActiveStaffInvitation(
  database: Queryable,
  ownerEmployeeId: string,
): Promise<StaffInvitationRow | null> {
  const result = await database.query(
    `SELECT id, kind, status, owner_employee_id, organization_id, use_count,
            last_used_at, created_at, revoked_at, expires_at, target_role
       FROM invitations
      WHERE owner_employee_id = $1 AND kind = 'staff_reusable' AND status = 'active'
      LIMIT 1`,
    [ownerEmployeeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, status: row.status,
    ownerEmployeeId: row.owner_employee_id, organizationId: row.organization_id,
    useCount: Number(row.use_count), lastUsedAt: row.last_used_at,
    createdAt: row.created_at, revokedAt: row.revoked_at,
    expiresAt: row.expires_at, targetRole: row.target_role,
  };
}

/** 按码查员工链接。注册路径用它——注册者手上只有码，没有 id。 */
export async function findStaffInvitationByHash(
  database: Queryable,
  codeHash: string,
): Promise<StaffInvitationRow | null> {
  const result = await database.query(
    `SELECT id, kind, status, owner_employee_id, organization_id, use_count,
            last_used_at, created_at, revoked_at, expires_at, target_role
       FROM invitations
      WHERE code_hash = $1 AND kind = 'staff_reusable'
      LIMIT 1`,
    [codeHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, status: row.status,
    ownerEmployeeId: row.owner_employee_id, organizationId: row.organization_id,
    useCount: Number(row.use_count), lastUsedAt: row.last_used_at,
    createdAt: row.created_at, revokedAt: row.revoked_at,
    expiresAt: row.expires_at, targetRole: row.target_role,
  };
}

export async function revokeStaffInvitation(
  database: Queryable,
  input: { ownerEmployeeId: string; revokedBy: string; now: string },
): Promise<{ revokedId: string | null }> {
  const result = await database.query<{ id: string }>(
    `UPDATE invitations
        SET status = 'revoked', revoked_at = $3, revoked_by_user_id = $2, updated_at = $3
      WHERE owner_employee_id = $1 AND kind = 'staff_reusable' AND status = 'active'
      RETURNING id`,
    [input.ownerEmployeeId, input.revokedBy, input.now],
  );
  return { revokedId: result.rows[0]?.id ?? null };
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
      WHERE id = $1 AND kind IN ('employee_reusable', 'staff_reusable')`,
    [input.invitationId, input.now],
  );
}

/**
 * 员工链接指向哪个端的登录页。
 *
 * 技术人员进运维端，其余内部角色进运营端。发错端的链接会让人登进一个自己没有任何
 * 权限的应用——页面能打开，点哪里都是 AccessDenied，而原因完全看不出来。
 */
export function staffInvitationAudience(targetRole: string): "operations" | "maintenance" {
  return targetRole === "tech_staff" ? "maintenance" : "operations";
}
