import type { Pool, PoolClient } from "pg";

import { hashPassword, normalizeEmail, validEmail } from "./auth.ts";
import type { AppAudience } from "./riverton-apps.ts";

type AccountCredential = {
  email: string;
  password: string;
};

export type AcceptanceAccountCredentials = Record<AppAudience, AccountCredential>;

type NormalizedAccount = AccountCredential & {
  audience: AppAudience;
  passwordHash: string;
  role: "customer" | "employee";
  roleCode: string;
  roleName: string;
  scope: "SELF" | "PLATFORM";
};

const ACCOUNT_DEFINITIONS: Record<AppAudience, Omit<NormalizedAccount, "email" | "password" | "passwordHash">> = {
  client: {
    audience: "client",
    role: "customer",
    roleCode: "acceptance_client_admin_v1",
    roleName: "客户端验收管理员",
    scope: "SELF",
  },
  operations: {
    audience: "operations",
    role: "employee",
    roleCode: "acceptance_operations_admin_v1",
    roleName: "运营端验收管理员",
    scope: "PLATFORM",
  },
  maintenance: {
    audience: "maintenance",
    role: "employee",
    roleCode: "acceptance_maintenance_admin_v1",
    roleName: "运维端验收管理员",
    scope: "PLATFORM",
  },
};

async function normalizedAccounts(input: AcceptanceAccountCredentials) {
  const accounts = await Promise.all((Object.keys(ACCOUNT_DEFINITIONS) as AppAudience[]).map(async (audience) => {
    const credential = input[audience];
    const email = normalizeEmail(credential?.email ?? "");
    const password = credential?.password ?? "";
    if (!validEmail(email)) throw new Error(`ACCEPTANCE_ACCOUNT_EMAIL_INVALID:${audience}`);
    const hasControlCharacter = [...password].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (password.length < 20 || password.length > 256 || hasControlCharacter) {
      throw new Error(`ACCEPTANCE_ACCOUNT_PASSWORD_INVALID:${audience}`);
    }
    return {
      ...ACCOUNT_DEFINITIONS[audience],
      email,
      password,
      passwordHash: await hashPassword(password),
    };
  }));
  if (new Set(accounts.map((account) => account.email)).size !== accounts.length) {
    throw new Error("ACCEPTANCE_ACCOUNT_EMAILS_NOT_DISTINCT");
  }
  return accounts;
}

async function activeBootstrapActor(client: PoolClient) {
  const administrators = await client.query<{
    id: string;
    organization_id: string | null;
  }>(`
    SELECT id, organization_id
    FROM users
    WHERE role = 'hq_admin' AND status = 'active'
    ORDER BY created_at, id
    FOR UPDATE
  `);
  if (administrators.rowCount !== 1) throw new Error("ACCEPTANCE_BOOTSTRAP_ADMIN_NOT_UNIQUE");
  const administrator = administrators.rows[0];
  const headquarters = await client.query<{ id: string }>(`
    SELECT id
    FROM organizations
    WHERE type = 'headquarters' AND status = 'active'
    ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, created_at, id
    FOR SHARE
  `, [administrator.organization_id]);
  if (!headquarters.rowCount) throw new Error("ACCEPTANCE_HEADQUARTERS_NOT_FOUND");
  const organizationId = headquarters.rows.some((row) => row.id === administrator.organization_id)
    ? administrator.organization_id!
    : headquarters.rowCount === 1 ? headquarters.rows[0].id : null;
  if (!organizationId) throw new Error("ACCEPTANCE_HEADQUARTERS_AMBIGUOUS");
  return { actorUserId: administrator.id, organizationId };
}

async function assertProvisioningPreconditions(client: PoolClient, accounts: NormalizedAccount[]) {
  const emails = accounts.map((account) => account.email);
  const existingAccounts = await client.query(`
    SELECT 1 FROM users
    WHERE lower(email) = ANY($1::text[])
    LIMIT 1
    FOR UPDATE
  `, [emails]);
  if (existingAccounts.rowCount) throw new Error("ACCEPTANCE_ACCOUNT_ALREADY_EXISTS");

  const roleCodes = accounts.map((account) => account.roleCode);
  const existingRoles = await client.query(`
    SELECT 1 FROM roles
    WHERE code = ANY($1::text[])
    LIMIT 1
    FOR UPDATE
  `, [roleCodes]);
  if (existingRoles.rowCount) throw new Error("ACCEPTANCE_ROLE_ALREADY_EXISTS");

  const catalog = await client.query<{ application_id: AppAudience; permission_count: number }>(`
    SELECT application.id AS application_id, count(permission.key)::int AS permission_count
    FROM applications AS application
    LEFT JOIN permission_definitions AS permission
      ON permission.application_id = application.id
     AND permission.status = 'active'
    WHERE application.id = ANY($1::text[])
      AND application.status = 'active'
    GROUP BY application.id
    ORDER BY application.id
  `, [accounts.map((account) => account.audience)]);
  const counts = new Map(catalog.rows.map((row) => [row.application_id, row.permission_count]));
  for (const account of accounts) {
    if (!counts.get(account.audience)) throw new Error(`ACCEPTANCE_PERMISSION_CATALOG_EMPTY:${account.audience}`);
  }
}

async function createAccount(client: PoolClient, input: {
  account: NormalizedAccount;
  actorUserId: string;
  organizationId: string;
  now: Date;
}) {
  const { account, actorUserId, organizationId, now } = input;
  const userId = crypto.randomUUID();
  const roleId = crypto.randomUUID();
  const timestamp = now.toISOString();
  const accountOrganizationId = account.audience === "client" ? null : organizationId;
  const reportsToUserId = account.audience === "client" ? null : actorUserId;

  await client.query(`
    INSERT INTO users (
      id, email, password_hash, role, organization_id, status,
      email_verified_at, reports_to_user_id, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$6,$6)
  `, [
    userId, account.email, account.passwordHash, account.role,
    accountOrganizationId, timestamp, reportsToUserId,
  ]);
  await client.query(`
    INSERT INTO roles (
      id, application_id, code, name, kind, created_organization_id,
      applies_to_organization_id, status, is_system, created_by_user_id
    ) VALUES ($1,$2,$3,$4,'custom',$5,$6,'published',false,$7)
  `, [
    roleId, account.audience, account.roleCode, account.roleName,
    organizationId, accountOrganizationId, actorUserId,
  ]);
  await client.query(`
    INSERT INTO role_permissions (
      id, role_id, permission_key, scope, scope_organization_ids_json
    )
    SELECT gen_random_uuid()::text, $1, permission.key, $2, '[]'::jsonb
    FROM permission_definitions AS permission
    WHERE permission.application_id = $3 AND permission.status = 'active'
    ORDER BY permission.key
  `, [roleId, account.scope, account.audience]);
  const assignmentId = crypto.randomUUID();
  await client.query(`
    INSERT INTO user_role_assignments (
      id, user_id, role_id, application_id, organization_id, status,
      effective_at, granted_by_user_id, reason, scope_organization_ids_json
    ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,'[]'::jsonb)
  `, [
    assignmentId, userId, roleId, account.audience, accountOrganizationId,
    now, actorUserId, "one-time acceptance account provisioning",
  ]);
  await client.query(`
    INSERT INTO audit_logs (
      id, actor_user_id, action, subject_type, subject_id, after_json, created_at
    ) VALUES ($1,$2,'system.acceptance_account_provisioned','user',$3,$4,$5)
  `, [crypto.randomUUID(), actorUserId, userId, JSON.stringify({
    applicationId: account.audience,
    roleCode: account.roleCode,
    scope: account.scope,
    credentialDelivery: "out_of_band_file",
    mfa: account.audience === "client" ? "optional" : "enrollment_required",
  }), timestamp]);
  return { userId, roleId, assignmentId, email: account.email };
}

export async function provisionAcceptanceAccounts(
  pool: Pool,
  input: AcceptanceAccountCredentials,
) {
  const accounts = await normalizedAccounts(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('agentnovas:acceptance-account-provisioning:v1', 0))");
    const { actorUserId, organizationId } = await activeBootstrapActor(client);
    await assertProvisioningPreconditions(client, accounts);
    const now = new Date();
    const created = {} as Record<AppAudience, Awaited<ReturnType<typeof createAccount>>>;
    for (const account of accounts) {
      created[account.audience] = await createAccount(client, {
        account,
        actorUserId,
        organizationId,
        now,
      });
    }
    await client.query("COMMIT");
    return { ok: true as const, actorUserId, organizationId, accounts: created };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
