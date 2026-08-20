import type { Pool, PoolClient } from "pg";

import { hashPassword, normalizeEmail, validEmail } from "./auth.ts";
import {
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
} from "./mfa.ts";
import { PERMISSION_DEFINITIONS } from "./rbac.ts";

type BootstrapInput = {
  email: string;
  password: string;
  adoptLegacyAdmin?: boolean;
  environment?: Record<string, string | undefined>;
};

async function ensureHeadquarters(client: PoolClient) {
  const existing = await client.query<{ id: string }>(`
    SELECT id FROM organizations
    WHERE type = 'headquarters' AND status = 'active'
    ORDER BY created_at
    LIMIT 1
  `);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = crypto.randomUUID();
  await client.query(`
    INSERT INTO organizations (id, type, name, status)
    VALUES ($1, 'headquarters', 'Riverton Capital 总公司', 'active')
  `, [id]);
  return id;
}

async function createSystemRole(client: PoolClient, input: {
  appId: "operations" | "maintenance";
  code: string;
  name: string;
  userId: string;
  organizationId: string;
}) {
  const role = await client.query<{ id: string }>(`
    INSERT INTO roles (
      id, application_id, code, name, kind, created_organization_id,
      applies_to_organization_id, status, is_system, created_by_user_id
    ) VALUES ($1, $2, $3, $4, 'system', $5, $5, 'published', true, $6)
    ON CONFLICT (application_id, code) DO UPDATE SET
      name = EXCLUDED.name,
      status = 'published',
      is_system = true,
      updated_at = now()
    RETURNING id
  `, [crypto.randomUUID(), input.appId, input.code, input.name, input.organizationId, input.userId]);
  const roleId = role.rows[0].id;
  await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
  for (const permission of PERMISSION_DEFINITIONS.filter((definition) => definition.appId === input.appId)) {
    await client.query(`
      INSERT INTO role_permissions (id, role_id, permission_key, scope)
      VALUES ($1, $2, $3, 'PLATFORM')
      ON CONFLICT (role_id, permission_key) DO UPDATE SET scope = 'PLATFORM'
    `, [crypto.randomUUID(), roleId, permission.key]);
  }
  await client.query(`
    INSERT INTO user_role_assignments (
      id, user_id, role_id, application_id, organization_id, status,
      effective_at, granted_by_user_id, reason, scope_organization_ids_json
    ) VALUES ($1, $2, $3, $4, $5, 'active', now(), $2, 'one-time CLI bootstrap', '[]'::jsonb)
  `, [crypto.randomUUID(), input.userId, roleId, input.appId, input.organizationId]);
}

export async function bootstrapInternalAdmin(pool: Pool, input: BootstrapInput) {
  const email = normalizeEmail(input.email);
  if (!validEmail(email)) throw new Error("管理员邮箱格式无效");
  const passwordHash = await hashPassword(input.password);
  const totpSecret = generateTotpSecret();
  const encryptedSecret = await encryptTotpSecret(totpSecret, input.environment ?? process.env);
  const recoveryCodes = generateRecoveryCodes();
  const recoveryHashes = await Promise.all(recoveryCodes.map((code) => hashRecoveryCode(code)));
  const client = await pool.connect();
  try {
    // The transaction-scoped advisory lock serializes all bootstrap attempts.
    // READ COMMITTED then refreshes the admin check after a waiter acquires it.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agentnovas:internal-bootstrap:v1', 0))");
    const existingAdmins = await client.query<{
      id: string;
      email: string;
      status: string;
      organization_id: string | null;
    }>(`
      SELECT id, email, status, organization_id
      FROM users
      WHERE role = 'hq_admin'
      ORDER BY created_at, id
      FOR UPDATE
    `);
    let adopted = false;
    let userId: string;
    let organizationId: string;
    const now = new Date();
    if (existingAdmins.rowCount) {
      if (!input.adoptLegacyAdmin) {
        await client.query("COMMIT");
        return { ok: false as const, code: "ALREADY_BOOTSTRAPPED" as const };
      }
      if (existingAdmins.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "LEGACY_ADMIN_AMBIGUOUS" as const };
      }
      const legacy = existingAdmins.rows[0];
      if (normalizeEmail(legacy.email) !== email) {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "LEGACY_ADMIN_EMAIL_MISMATCH" as const };
      }
      if (legacy.status !== "active") {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "LEGACY_ADMIN_NOT_ACTIVE" as const };
      }
      const securityState = await client.query(`
        SELECT
          EXISTS (SELECT 1 FROM user_mfa_totp_credentials WHERE user_id = $1) AS has_mfa,
          EXISTS (SELECT 1 FROM user_role_assignments WHERE user_id = $1 AND application_id IN ('operations', 'maintenance')) AS has_assignment
      `, [legacy.id]);
      if (securityState.rows[0]?.has_mfa || securityState.rows[0]?.has_assignment) {
        await client.query("COMMIT");
        return { ok: false as const, code: "ALREADY_BOOTSTRAPPED" as const };
      }
      userId = legacy.id;
      organizationId = legacy.organization_id ?? await ensureHeadquarters(client);
      await client.query(`
        UPDATE users SET password_hash = $2, organization_id = $3,
          email_verified_at = COALESCE(email_verified_at, $4), updated_at = $4
        WHERE id = $1
      `, [userId, passwordHash, organizationId, now.toISOString()]);
      await client.query(`UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, now.toISOString()]);
      adopted = true;
    } else {
      const emailInUse = await client.query(`SELECT 1 FROM users WHERE email = $1 LIMIT 1`, [email]);
      if (emailInUse.rowCount) {
        await client.query("ROLLBACK");
        return { ok: false as const, code: "EMAIL_IN_USE" as const };
      }
      organizationId = await ensureHeadquarters(client);
      userId = crypto.randomUUID();
      await client.query(`
        INSERT INTO users (
          id, email, password_hash, role, organization_id, status,
          email_verified_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 'hq_admin', $4, 'active', $5, $5, $5)
      `, [userId, email, passwordHash, organizationId, now.toISOString()]);
    }
    await client.query(`
      INSERT INTO user_mfa_totp_credentials (
        user_id, encrypted_secret, encryption_key_version, status, enabled_at
      ) VALUES ($1, $2, 1, 'active', $3)
    `, [userId, encryptedSecret, now]);
    for (const recoveryHash of recoveryHashes) {
      await client.query(`
        INSERT INTO user_mfa_recovery_codes (id, user_id, code_hash)
        VALUES ($1, $2, $3)
      `, [crypto.randomUUID(), userId, recoveryHash]);
    }
    await createSystemRole(client, {
      appId: "operations",
      code: "ops_bootstrap_admin",
      name: "运营端初始管理员",
      userId,
      organizationId,
    });
    await createSystemRole(client, {
      appId: "maintenance",
      code: "maint_bootstrap_admin",
      name: "运维端初始管理员",
      userId,
      organizationId,
    });
    await client.query(`
      INSERT INTO audit_logs (id, actor_user_id, action, subject_type, subject_id, after_json)
      VALUES ($1, $2, $3, 'user', $2, $4)
    `, [crypto.randomUUID(), userId, adopted ? "system.cli_bootstrap_legacy_adopted" : "system.cli_bootstrap", JSON.stringify({ applications: ["operations", "maintenance"], mfa: "totp", adopted })]);
    await client.query("COMMIT");
    const label = encodeURIComponent("Riverton Capital:internal-admin");
    const issuer = encodeURIComponent("Riverton Capital");
    return {
      ok: true as const,
      adopted,
      userId,
      totpUri: `otpauth://totp/${label}?secret=${totpSecret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
      recoveryCodes,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
