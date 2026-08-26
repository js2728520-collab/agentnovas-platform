import type { Pool, PoolClient } from "pg";

import { sha256 } from "./auth.ts";
import { consumeAuthRateLimit } from "./auth-rate-limit.ts";
import { legacyRoleAssignments, type DataScope } from "./rbac.ts";
import { ResearchApiError } from "./research-errors.ts";
import {
  checkOrganizationName,
  resolveInternalRegistrationLinkScope,
  type InternalOperationRole,
} from "../packages/domain/src/organization-provisioning.ts";

type LinkTargetRole = Exclude<InternalOperationRole, "hq_admin">;
type LinkPermissionSnapshot = Array<{ permission_key: string; scope: DataScope }>;

type IssueInternalRegistrationLinkInput = {
  issuerUserId: string;
  issuerRole: string;
  issuerOrganizationId: string | null;
  targetRole: string;
  targetOrganizationId: string | null;
  now?: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type RegisterWithInternalRegistrationLinkInput = {
  tokenHash: string;
  email: string;
  passwordHash: string;
  organizationName?: string;
  now?: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

const roleLabels: Record<LinkTargetRole, string> = {
  branch_admin: "分公司总经理",
  manager: "经理",
  supervisor: "主管",
  employee: "员工",
};

function generatedToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function permissionsForTargetRole(targetRole: LinkTargetRole): LinkPermissionSnapshot {
  const assignment = legacyRoleAssignments(targetRole).find((candidate) => candidate.appId === "operations");
  if (!assignment?.permissions.length) {
    throw new ResearchApiError("INTERNAL_REGISTRATION_ROLE_UNAVAILABLE", "目标角色没有可发布权限", 409);
  }
  return assignment.permissions
    .map((permission) => ({ permission_key: permission.permissionKey, scope: permission.scope }))
    .sort((left, right) => left.permission_key.localeCompare(right.permission_key));
}

function canonicalPermissionSnapshot(value: unknown) {
  if (!Array.isArray(value)) return null;
  const normalized: LinkPermissionSnapshot = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const permissionKey = "permission_key" in item ? item.permission_key : undefined;
    const scope = "scope" in item ? item.scope : undefined;
    if (typeof permissionKey !== "string" || typeof scope !== "string") return null;
    normalized.push({ permission_key: permissionKey, scope: scope as DataScope });
  }
  return JSON.stringify(normalized.sort((left, right) => left.permission_key.localeCompare(right.permission_key)));
}

async function rollback(client: PoolClient) {
  await client.query("ROLLBACK").catch(() => undefined);
}

export async function consumeInternalRegistrationRateLimit(pool: Pool, input: {
  email: string;
  tokenHash: string;
  connectionBucketKey: string;
  now?: Date;
}) {
  for (const bucketKeys of [
    [`email:${input.email}`],
    [`token:${input.tokenHash}`],
    [input.connectionBucketKey],
  ]) {
    const result = await consumeAuthRateLimit(pool, {
      action: "register",
      audience: "operations",
      bucketKeys,
      maxAttempts: bucketKeys[0]?.startsWith("email:") ? 5 : bucketKeys[0]?.startsWith("token:") ? 20 : 30,
      windowSeconds: 15 * 60,
      blockSeconds: 15 * 60,
      now: input.now,
    });
    if (!result.allowed) return result;
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function recordInternalRegistrationLinkFailure(pool: Pool, input: {
  tokenHash: string;
  code: string;
  ipAddress: string | null;
  userAgent: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  await pool.query(`
    INSERT INTO audit_logs(
      id,actor_user_id,action,subject_type,subject_id,after_json,ip_address,user_agent,created_at
    ) VALUES($1,NULL,'internal_registration_link.failed','internal_registration_link',$2,$3::jsonb,$4,$5,$6)
  `, [
    crypto.randomUUID(), `token-hash:${input.tokenHash.slice(0, 16)}`,
    JSON.stringify({ code: input.code }), input.ipAddress, input.userAgent, now,
  ]);
}

function registrationConflict(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "23505") return null;
  const constraint = "constraint" in error ? String(error.constraint ?? "") : "";
  if (/email/i.test(constraint)) return new ResearchApiError("EMAIL_TAKEN", "该邮箱已注册", 409);
  return null;
}

export async function issueInternalRegistrationLink(pool: Pool, input: IssueInternalRegistrationLinkInput) {
  const scope = resolveInternalRegistrationLinkScope({
    issuerRole: input.issuerRole,
    targetRole: input.targetRole,
    issuerOrganizationId: input.issuerOrganizationId,
    targetOrganizationId: input.targetOrganizationId,
  });
  if (!scope.ok) {
    throw new ResearchApiError(scope.code, "不能为该角色或组织范围生成注册链接", 403);
  }
  const targetRole = input.targetRole as LinkTargetRole;
  const permissions = permissionsForTargetRole(targetRole);
  const permissionSnapshotJson = JSON.stringify(permissions);
  const permissionSnapshotSha256 = await sha256(permissionSnapshotJson);
  const token = generatedToken();
  const tokenHash = await sha256(token);
  const now = input.now ?? new Date();
  const id = crypto.randomUUID();
  const roleId = crypto.randomUUID();
  const roleCode = `registration_link_${id.replaceAll("-", "")}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `agentnovas:internal-registration-link:${input.issuerUserId}:${targetRole}:${scope.organizationMode}:${scope.organizationId ?? ""}`,
    ]);
    if (scope.organizationId) {
      const organization = await client.query(
        "SELECT id FROM organizations WHERE id=$1 AND status='active' FOR SHARE",
        [scope.organizationId],
      );
      if (!organization.rows[0]) {
        throw new ResearchApiError("TARGET_ORGANIZATION_UNAVAILABLE", "目标分公司不存在或已停用", 409);
      }
    }
    const revoked = await client.query<{ id: string }>(`
      UPDATE internal_registration_links
         SET status='revoked',revoked_at=$1,revoked_by_user_id=$2,updated_at=$1
       WHERE issuer_user_id=$2
         AND target_role=$3
         AND organization_mode=$4
         AND organization_id IS NOT DISTINCT FROM $5
         AND status='active'
      RETURNING id
    `, [now, input.issuerUserId, targetRole, scope.organizationMode, scope.organizationId]);
    await client.query(`
      INSERT INTO roles(
        id,application_id,code,name,kind,created_organization_id,
        applies_to_organization_id,status,is_system,created_by_user_id,created_at,updated_at
      ) VALUES($1,'operations',$2,$3,'custom',$4,$4,'published',false,$5,$6,$6)
    `, [roleId, roleCode, `注册链接专用角色：${roleLabels[targetRole]}`, scope.organizationId, input.issuerUserId, now]);
    for (const permission of permissions) {
      await client.query(`
        INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json,created_at)
        VALUES($1,$2,$3,$4,'[]'::jsonb,$5)
      `, [crypto.randomUUID(), roleId, permission.permission_key, permission.scope, now]);
    }
    await client.query(`
      INSERT INTO internal_registration_links(
        id,token_hash,issuer_user_id,role_id,target_role,organization_mode,
        organization_id,permission_snapshot_json,permission_snapshot_sha256,
        status,use_count,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'active',0,$10,$10)
    `, [
      id, tokenHash, input.issuerUserId, roleId, targetRole, scope.organizationMode,
      scope.organizationId, permissionSnapshotJson, permissionSnapshotSha256, now,
    ]);
    await client.query(`
      INSERT INTO audit_logs(
        id,actor_user_id,action,subject_type,subject_id,after_json,ip_address,user_agent,created_at
      ) VALUES($1,$2,$3,'internal_registration_link',$4,$5::jsonb,$6,$7,$8)
    `, [
      crypto.randomUUID(), input.issuerUserId,
      revoked.rows.length ? "internal_registration_link.regenerated" : "internal_registration_link.created",
      id,
      JSON.stringify({
        targetRole,
        organizationMode: scope.organizationMode,
        organizationId: scope.organizationId,
        permissionSnapshotSha256,
        replacedLinkIds: revoked.rows.map((row) => row.id),
      }),
      input.ipAddress ?? null,
      input.userAgent ?? null,
      now,
    ]);
    await client.query("COMMIT");
    return {
      id,
      token,
      targetRole,
      organizationMode: scope.organizationMode,
      organizationId: scope.organizationId,
      permissionSnapshot: permissions,
      status: "active" as const,
      expiresAt: null,
      replacedLinkIds: revoked.rows.map((row) => row.id),
      createdAt: now.toISOString(),
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeInternalRegistrationLink(pool: Pool, input: {
  linkId: string;
  actorUserId: string;
  now?: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const revoked = await client.query<{ id: string; target_role: string; organization_id: string | null }>(`
      UPDATE internal_registration_links
         SET status='revoked',revoked_at=$1,revoked_by_user_id=$2,updated_at=$1
       WHERE id=$3 AND issuer_user_id=$2 AND status='active'
      RETURNING id,target_role,organization_id
    `, [now, input.actorUserId, input.linkId]);
    const link = revoked.rows[0];
    if (!link) {
      throw new ResearchApiError(
        "INTERNAL_REGISTRATION_LINK_NOT_ACTIVE",
        "注册链接不存在、已作废或不属于当前账号",
        409,
      );
    }
    await client.query(`
      INSERT INTO audit_logs(
        id,actor_user_id,action,subject_type,subject_id,after_json,ip_address,user_agent,created_at
      ) VALUES($1,$2,'internal_registration_link.revoked','internal_registration_link',$3,$4::jsonb,$5,$6,$7)
    `, [
      crypto.randomUUID(), input.actorUserId, link.id,
      JSON.stringify({ targetRole: link.target_role, organizationId: link.organization_id }),
      input.ipAddress ?? null, input.userAgent ?? null, now,
    ]);
    await client.query("COMMIT");
    return { revoked: true as const, linkId: link.id };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordInternalRegistrationLinkCopied(pool: Pool, input: {
  linkId: string;
  actorUserId: string;
  now?: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const now = input.now ?? new Date();
  const recorded = await pool.query<{ id: string }>(`
    INSERT INTO audit_logs(
      id,actor_user_id,action,subject_type,subject_id,after_json,ip_address,user_agent,created_at
    )
    SELECT $1,$2,'internal_registration_link.copied','internal_registration_link',link.id,
           jsonb_build_object('targetRole',link.target_role,'organizationId',link.organization_id),
           $4,$5,$6
      FROM internal_registration_links link
     WHERE link.id=$3 AND link.issuer_user_id=$2 AND link.status='active'
    RETURNING subject_id AS id
  `, [
    crypto.randomUUID(), input.actorUserId, input.linkId,
    input.ipAddress ?? null, input.userAgent ?? null, now,
  ]);
  if (!recorded.rows[0]) {
    throw new ResearchApiError("INTERNAL_REGISTRATION_LINK_NOT_ACTIVE", "注册链接不存在或已作废", 409);
  }
  return { recorded: true as const };
}

export async function listInternalRegistrationLinks(pool: Pool, issuerUserId: string) {
  const result = await pool.query<{
    id: string;
    target_role: LinkTargetRole;
    organization_mode: "CREATE_BRANCH" | "EXISTING_ORGANIZATION";
    organization_id: string | null;
    organization_name: string | null;
    permission_snapshot_json: LinkPermissionSnapshot;
    permission_snapshot_sha256: string;
    status: "active" | "revoked";
    use_count: string;
    last_used_at: Date | string | null;
    revoked_at: Date | string | null;
    created_at: Date | string;
  }>(`
    SELECT link.id,link.target_role,link.organization_mode,link.organization_id,
           organization.name AS organization_name,link.permission_snapshot_json,
           link.permission_snapshot_sha256,link.status,link.use_count,link.last_used_at,
           link.revoked_at,link.created_at
      FROM internal_registration_links link
      LEFT JOIN organizations organization ON organization.id=link.organization_id
     WHERE link.issuer_user_id=$1
     ORDER BY (link.status='active') DESC,link.created_at DESC,link.id DESC
     LIMIT 200
  `, [issuerUserId]);
  return result.rows.map((row) => ({
    id: row.id,
    targetRole: row.target_role,
    targetRoleLabel: roleLabels[row.target_role],
    organizationMode: row.organization_mode,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    permissionSnapshot: row.permission_snapshot_json,
    permissionSnapshotSha256: row.permission_snapshot_sha256,
    status: row.status,
    useCount: Number(row.use_count),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: null,
  }));
}

export async function registerWithInternalRegistrationLink(
  pool: Pool,
  input: RegisterWithInternalRegistrationLinkInput,
) {
  if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) {
    throw new ResearchApiError("INTERNAL_REGISTRATION_LINK_INVALID", "注册链接无效或已作废", 400);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const linkResult = await client.query<{
      id: string;
      issuer_user_id: string;
      role_id: string;
      target_role: LinkTargetRole;
      organization_mode: "CREATE_BRANCH" | "EXISTING_ORGANIZATION";
      organization_id: string | null;
      permission_snapshot_json: unknown;
      permission_snapshot_sha256: string;
      status: string;
    }>(`
      SELECT id,issuer_user_id,role_id,target_role,organization_mode,organization_id,
             permission_snapshot_json,permission_snapshot_sha256,status
        FROM internal_registration_links
       WHERE token_hash=$1
       FOR UPDATE
    `, [input.tokenHash]);
    const link = linkResult.rows[0];
    if (!link || link.status !== "active") {
      throw new ResearchApiError("INTERNAL_REGISTRATION_LINK_INVALID", "注册链接无效或已作废", 400);
    }
    const role = await client.query<{ status: string; application_id: string }>(
      "SELECT status,application_id FROM roles WHERE id=$1 FOR SHARE",
      [link.role_id],
    );
    const actualPermissions = (await client.query<{ permission_key: string; scope: DataScope }>(`
      SELECT permission_key,scope
        FROM role_permissions
       WHERE role_id=$1
       ORDER BY permission_key
    `, [link.role_id])).rows;
    const canonicalPermissions = JSON.stringify(actualPermissions);
    const snapshotPermissions = canonicalPermissionSnapshot(link.permission_snapshot_json);
    if (
      role.rows[0]?.status !== "published"
      || role.rows[0]?.application_id !== "operations"
      || canonicalPermissions !== snapshotPermissions
      || await sha256(canonicalPermissions) !== link.permission_snapshot_sha256
    ) {
      throw new ResearchApiError(
        "INTERNAL_REGISTRATION_LINK_INTEGRITY_FAILED",
        "注册链接权限完整性校验失败，已拒绝注册",
        409,
      );
    }

    const organizationCheck = checkOrganizationName(link.target_role, input.organizationName);
    if (!organizationCheck.ok) {
      throw new ResearchApiError(organizationCheck.code, organizationCheck.message, 400);
    }
    const now = input.now ?? new Date();
    let organizationId = link.organization_id;
    if (link.organization_mode === "CREATE_BRANCH") {
      organizationId = crypto.randomUUID();
      await client.query(`
        INSERT INTO organizations(id,type,name,status,created_at,updated_at)
        VALUES($1,'branch',$2,'active',$3,$3)
      `, [organizationId, organizationCheck.name, now]);
    } else if (!organizationId) {
      throw new ResearchApiError("INTERNAL_REGISTRATION_LINK_INTEGRITY_FAILED", "注册链接缺少组织范围", 409);
    }

    const userId = crypto.randomUUID();
    await client.query(`
      INSERT INTO users(
        id,email,password_hash,role,organization_id,reports_to_user_id,
        status,created_at,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,'active',$7,$7)
    `, [
      userId, input.email, input.passwordHash, link.target_role,
      organizationId, link.issuer_user_id, now,
    ]);
    await client.query(`
      INSERT INTO user_role_assignments(
        id,user_id,role_id,application_id,organization_id,
        scope_organization_ids_json,status,effective_at,granted_by_user_id,reason,
        created_at,updated_at
      ) VALUES($1,$2,$3,'operations',$4,jsonb_build_array($4::text),'active',$5,$6,$7,$5,$5)
    `, [
      crypto.randomUUID(), userId, link.role_id, organizationId, now,
      link.issuer_user_id, `通过权限注册链接 ${link.id} 自助注册`,
    ]);
    await client.query(`
      INSERT INTO internal_registration_link_uses(id,link_id,registered_user_id,used_at)
      VALUES($1,$2,$3,$4)
    `, [crypto.randomUUID(), link.id, userId, now]);
    await client.query(`
      UPDATE internal_registration_links
         SET use_count=use_count+1,last_used_at=$1,updated_at=$1
       WHERE id=$2
    `, [now, link.id]);
    await client.query(`
      INSERT INTO audit_logs(
        id,actor_user_id,action,subject_type,subject_id,after_json,ip_address,user_agent,created_at
      ) VALUES($1,$2,'internal_registration_link.used','user',$2,$3::jsonb,$4,$5,$6)
    `, [
      crypto.randomUUID(), userId,
      JSON.stringify({
        linkId: link.id,
        issuerUserId: link.issuer_user_id,
        targetRole: link.target_role,
        organizationId,
        permissionSnapshotSha256: link.permission_snapshot_sha256,
      }),
      input.ipAddress, input.userAgent, now,
    ]);
    await client.query("COMMIT");
    return {
      userId,
      role: link.target_role,
      roleId: link.role_id,
      organizationId: organizationId!,
      status: "active" as const,
      mfaEnrollmentRequired: true as const,
    };
  } catch (error) {
    await rollback(client);
    throw registrationConflict(error) ?? error;
  } finally {
    client.release();
  }
}
