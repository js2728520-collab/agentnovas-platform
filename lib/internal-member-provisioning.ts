import type { Pool } from "pg";

import { legacyRoleAssignments } from "./rbac.ts";

type InternalRole = "branch_admin" | "manager" | "supervisor" | "employee" | "finance" | "auditor" | "hq_support";

export async function provisionInternalMember(pool: Pool, input: {
  actorUserId: string;
  userId: string;
  email: string;
  passwordHash: string;
  role: InternalRole;
  organizationId: string | null;
  organizationName?: string;
  reportsToUserId: string;
  activationTokenHash: string;
  encryptedNotificationToken: string;
  now?: Date;
}) {
  const assignment = legacyRoleAssignments(input.role).find((candidate) => candidate.appId === "operations");
  if (!assignment || !assignment.permissions.length) throw new Error("INTERNAL_ROLE_NOT_PROVISIONABLE");
  const now = input.now ?? new Date();
  const activationExpiresAt = new Date(now.getTime() + 48 * 3600_000);
  const organizationId = input.organizationId ?? crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`agentnovas:default-role:${assignment.roleCode}`]);
    if (!input.organizationId) {
      await client.query(`INSERT INTO organizations (id, type, name, status) VALUES ($1, 'branch', $2, 'active')`, [
        organizationId,
        input.organizationName?.trim().slice(0, 120) || input.email.split("@")[0],
      ]);
    }
    await client.query(`
      INSERT INTO users (id, email, password_hash, role, organization_id, reports_to_user_id, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $7)
    `, [input.userId, input.email, input.passwordHash, input.role, organizationId, input.reportsToUserId, now]);

    const insertedRole = await client.query<{ id: string }>(`
      INSERT INTO roles (id, application_id, code, name, kind, status, is_system, created_by_user_id)
      VALUES ($1, 'operations', $2, $3, 'system', 'published', true, $4)
      ON CONFLICT (application_id, code) DO NOTHING
      RETURNING id
    `, [crypto.randomUUID(), assignment.roleCode, `运营默认角色：${input.role}`, input.actorUserId]);
    const role = insertedRole.rows[0] ?? (await client.query<{ id: string }>(`
      SELECT id FROM roles
      WHERE application_id = 'operations' AND code = $1 AND is_system = true
      FOR UPDATE
    `, [assignment.roleCode])).rows[0];
    if (!role) throw new Error("DEFAULT_ROLE_CODE_CONFLICT");
    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [role.id]);
    for (const permission of assignment.permissions) {
      await client.query(`
        INSERT INTO role_permissions (id, role_id, permission_key, scope)
        VALUES ($1, $2, $3, $4)
      `, [crypto.randomUUID(), role.id, permission.permissionKey, permission.scope]);
    }
    await client.query(`
      INSERT INTO user_role_assignments (
        id, user_id, role_id, application_id, organization_id,
        scope_organization_ids_json, status, effective_at, granted_by_user_id, reason
      ) VALUES ($1, $2, $3, 'operations', $4, jsonb_build_array($4::text), 'active', $5, $6, 'internal member invitation')
    `, [crypto.randomUUID(), input.userId, role.id, organizationId, now, input.actorUserId]);
    await client.query(`
      INSERT INTO auth_tokens (id, user_id, token_hash, purpose, token_audience, expires_at)
      VALUES ($1, $2, $3, 'reset_password', 'operations', $4)
    `, [crypto.randomUUID(), input.userId, input.activationTokenHash, activationExpiresAt]);
    await client.query(`
      INSERT INTO notification_deliveries (
        id, user_id, channel, category, template_key, payload_json, scheduled_at
      ) VALUES ($1, $2, 'email', 'login_security', 'internal_account_invite', $3, $4)
    `, [
      crypto.randomUUID(), input.userId,
      JSON.stringify({
        encryptedToken: input.encryptedNotificationToken,
        role: input.role,
        activation: true,
        audience: "operations",
        expiresAt: activationExpiresAt.toISOString(),
      }),
      now.toISOString(),
    ]);
    await client.query(`
      INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json, created_at)
      VALUES ($1, $2, 'organization.member_created', 'user', $3, $4, $5)
    `, [
      crypto.randomUUID(), input.actorUserId, input.userId,
      JSON.stringify({ email: input.email, role: input.role, organizationId, activation: "email_set_password", explicitAssignment: true }),
      now,
    ]);
    await client.query("COMMIT");
    return { userId: input.userId, organizationId, roleId: role.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
