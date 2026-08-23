/**
 * 内部员工的体验账号。
 *
 * 公司人员要熟悉业务，就需要一个真实的客户账号。但员工的工号账号进不了客户端——
 * `migration 0040` 有一条 RESTRICTIVE RLS：客户端 Web 的数据库角色只能看到
 * `role = 'customer'` 的用户和他们的会话。放开那条等于让公网应用的数据库角色
 * 读到全部内部账号，那是三端隔离里唯一不依赖应用代码正确性的一层。
 *
 * 所以体验账号是**另一个独立的客户账号**，和工号账号分开。
 *
 * 关键在于它不能进业绩口径：如果员工用自己的邀请链接注册体验账号，他的仓位会算成
 * 他自己的业绩，主管、经理、分公司跟着一路分成——一个可以自我刷单的口子。
 * 因此这里直接建归因行并打上 is_internal，而不是走客户邀请链接。
 */

import type { Pool } from "pg";

export type InternalExperienceAccountInput = {
  /** 工号账号，体验账号的归属人。 */
  ownerUserId: string;
  /** 体验账号的登录信息。由员工自己设定，不经过邀请链接。 */
  customerUserId: string;
  email: string;
  phone: string;
  passwordHash: string;
  reason: string;
  organizationId: string | null;
  now?: Date;
};

export async function provisionInternalExperienceAccount(
  pool: Pool,
  input: InternalExperienceAccountInput,
): Promise<{ customerId: string }> {
  const reason = input.reason.trim();
  // 原因必填：一个没有说明的内部账号，事后没人知道它为什么不计业绩。
  if (!reason) throw new Error("INTERNAL_EXPERIENCE_REASON_REQUIRED");
  const now = (input.now ?? new Date()).toISOString();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 工号账号必须是内部角色。允许客户给自己开体验账号毫无意义，
    // 而且会让 internal_owner_user_id 指向一个不在汇报体系里的节点。
    const owner = (await client.query<{ role: string; organization_id: string | null }>(
      "SELECT role, organization_id FROM users WHERE id = $1 AND status = 'active'",
      [input.ownerUserId],
    )).rows[0];
    if (!owner) throw new Error("INTERNAL_EXPERIENCE_OWNER_NOT_FOUND");
    if (owner.role === "customer") throw new Error("INTERNAL_EXPERIENCE_OWNER_NOT_INTERNAL");

    // 一人一个体验账号。多个的话，「哪个是他的」这个问题没有答案，
    // 而运营在客户列表里会看到同一个人的多条记录。
    const existing = (await client.query<{ customer_id: string }>(
      `SELECT customer_id FROM customer_attributions
        WHERE internal_owner_user_id = $1 AND is_internal = true AND status = 'active' LIMIT 1`,
      [input.ownerUserId],
    )).rows[0];
    if (existing) throw new Error("INTERNAL_EXPERIENCE_ALREADY_EXISTS");

    await client.query(
      `INSERT INTO users (id, email, phone, password_hash, role, status, organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'customer', 'active', NULL, $5, $5)`,
      [input.customerUserId, input.email, input.phone, input.passwordHash, now],
    );

    // 归因行的 employee_id 等字段留空：体验账号不属于任何人的业绩。
    // internal_owner_user_id 记的是「这是谁的账号」，与业绩归属是两件事。
    await client.query(
      `INSERT INTO customer_attributions (
         id, customer_id, source, status, branch_id, manager_id, supervisor_id, employee_id,
         effective_at, reason, is_internal, internal_owner_user_id, internal_reason
       ) VALUES ($1, $2, 'manual_transfer', 'active', $3, NULL, NULL, NULL, $4, $5, true, $6, $5)`,
      [
        crypto.randomUUID(), input.customerUserId,
        input.organizationId ?? owner.organization_id,
        now, reason, input.ownerUserId,
      ],
    );

    await client.query(
      `INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json)
       VALUES ($1, $2, 'internal_experience_account.created', 'user', $3, $4)`,
      [crypto.randomUUID(), input.ownerUserId, input.customerUserId,
       JSON.stringify({ reason, ownerRole: owner.role })],
    );

    await client.query("COMMIT");
    return { customerId: input.customerUserId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
