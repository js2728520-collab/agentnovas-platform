import { requireCurrentAccessReviewer } from "@/lib/access-control";
import { accessUserScopePredicate, scopeCanDelegate } from "@/lib/access-center-scope";
import { lockScopedRoleForTarget } from "@/lib/access-role-authorization";
import { parseAccessChangeRequest, type AccessChange } from "@/lib/access-change-requests";
import { canApproveAccessChange } from "@/lib/rbac";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

function requestedPermissionKeys(change: AccessChange) {
  if (change.changeType === "role_create" || change.changeType === "template_publish") return change.after.permissions.map((permission) => permission.permissionKey);
  return [];
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, appId, scope, organizationIds } = await requireCurrentAccessReviewer(request);
    const { id } = await context.params;
    const body = await readResearchJson(request);
    const decision = String(body.decision ?? "");
    if (decision !== "approve" && decision !== "reject") throw new ResearchApiError("VALIDATION_ERROR", "审批决定无效", 422, { fields: ["decision"] });
    const note = String(body.note ?? "").trim().slice(0, 500);
    if (!note) throw new ResearchApiError("VALIDATION_ERROR", "必须填写审批意见", 422, { fields: ["note"] });
    const pool = await getPostgresPool();
    const client = await pool.connect();
    let status: "approved" | "rejected";
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        application_id: string; target_user_id: string | null; target_role_id: string | null;
        change_type: AccessChange["changeType"]; before_json: Record<string, unknown>; after_json: Record<string, unknown>;
        requested_by_user_id: string; status: string;
      }>("SELECT * FROM access_change_requests WHERE id = $1 AND application_id = $2 FOR UPDATE", [id, appId]);
      const row = locked.rows[0];
      if (!row) throw new ResearchApiError("NOT_FOUND", "权限变更申请不存在", 404);
      if (row.requested_by_user_id === user.id) throw new ResearchApiError("FORBIDDEN", "申请人不能审批自己的权限变更", 403);
      if (row.status !== "pending") throw new ResearchApiError("CONFLICT", "权限变更申请已处理", 409);
      const change = parseAccessChangeRequest({
        applicationId: row.application_id, changeType: row.change_type,
        targetUserId: row.target_user_id, targetRoleId: row.target_role_id,
        before: row.before_json, after: row.after_json,
      });
      let targetOrganizationId: string | null | undefined;
      if (change.targetUserId) {
        const scopePredicate = accessUserScopePredicate({
          scope,
          actor: { id: user.id, organizationId: user.organizationId },
          organizationIds,
          userAlias: "target_user",
          startIndex: 2,
        });
        const target = await client.query<{ id: string; organization_id: string | null }>(`
          SELECT target_user.id, target_user.organization_id
          FROM users AS target_user
          WHERE target_user.id = $1 AND (${scopePredicate.clause})
          FOR UPDATE OF target_user
        `, [change.targetUserId, ...scopePredicate.values]);
        if (!target.rows[0]) throw new ResearchApiError("FORBIDDEN", "不能审批授权范围外的用户变更", 403);
        targetOrganizationId = target.rows[0].organization_id;
      } else if (scope !== "PLATFORM") {
        throw new ResearchApiError("FORBIDDEN", "应用级角色变更需要平台范围审批", 403);
      }
      const approverAccess = await client.query<{ permission_key: string }>(`
        SELECT rp.permission_key FROM user_role_assignments ura
        JOIN roles r ON r.id = ura.role_id AND r.application_id = ura.application_id
        JOIN role_permissions rp ON rp.role_id = r.id
        JOIN permission_definitions pd ON pd.key = rp.permission_key
          AND pd.application_id = r.application_id AND pd.status = 'active'
        WHERE ura.user_id = $1 AND ura.application_id = $2 AND ura.status = 'active'
          AND r.status = 'published' AND ura.effective_at <= now()
          AND (ura.expires_at IS NULL OR ura.expires_at > now())
      `, [user.id, row.application_id]);
      const permissionKeys = approverAccess.rows.map((permission) => permission.permission_key);
      const reviewerPermissions = row.application_id === "operations"
        ? ["ops.roles.approve_sensitive", "ops.roles.manage"]
        : row.application_id === "maintenance"
          ? ["maint.roles.approve_sensitive", "maint.roles.manage"]
          : [];
      if (!reviewerPermissions.some((permission) => permissionKeys.includes(permission))) {
        throw new ResearchApiError("FORBIDDEN", "审批人不具备当前应用的授权审批权限", 403);
      }
      const requested = requestedPermissionKeys(change);
      if (change.changeType === "role_assign") {
        const role = await lockScopedRoleForTarget(client, {
          roleId: change.targetRoleId,
          appId: change.applicationId,
          targetOrganizationId: targetOrganizationId ?? null,
          scope,
          actor: { id: user.id, organizationId: user.organizationId },
          organizationIds,
        });
        if (!role) throw new ResearchApiError("FORBIDDEN", "不能审批授权范围外或不适用于目标组织的角色", 403);
        const rolePermissions = await client.query<{ permission_key: string; scope: Parameters<typeof scopeCanDelegate>[1] }>(`
          SELECT rp.permission_key, rp.scope FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id
          JOIN permission_definitions pd ON pd.key = rp.permission_key
          WHERE rp.role_id = $1 AND r.application_id = $2
            AND pd.application_id = r.application_id AND pd.status = 'active'
        `, [change.targetRoleId, change.applicationId]);
        requested.push(...rolePermissions.rows.map((permission) => permission.permission_key));
        if (rolePermissions.rows.some((permission) => !scopeCanDelegate(scope, permission.scope))) {
          throw new ResearchApiError("SCOPE_ESCALATION", "不能审批数据范围大于自身授权的角色", 403);
        }
      }
      const approval = canApproveAccessChange({ requesterUserId: row.requested_by_user_id, approverUserId: user.id, approverPermissionKeys: permissionKeys, requestedPermissionKeys: requested });
      if (!approval.ok) throw new ResearchApiError("FORBIDDEN", "审批人不满足授权审批规则", 403, { code: approval.code });
      const decisionInsert = await client.query(`
        INSERT INTO access_change_decisions (id, request_id, reviewer_user_id, decision, note)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (request_id, reviewer_user_id) DO NOTHING
        RETURNING id
      `, [crypto.randomUUID(), id, user.id, decision, note]);
      if (!decisionInsert.rows[0]) throw new ResearchApiError("CONFLICT", "该审批人已处理此申请", 409);
      status = decision === "approve" ? "approved" : "rejected";
      if (decision === "approve") await applyApprovedChange(client, change, user.id);
      const requestUpdate = await client.query(`UPDATE access_change_requests SET status = $1, completed_at = now() WHERE id = $2 AND status = 'pending' RETURNING id`, [status, id]);
      if (!requestUpdate.rows[0]) throw new ResearchApiError("CONFLICT", "权限变更申请状态已变化", 409);
      await client.query(`
        INSERT INTO authorization_audit_events
          (id, actor_user_id, application_id, action, subject_type, subject_id, before_json, after_json)
        VALUES ($1, $2, $3, $4, 'access_change_request', $5, $6::jsonb, $7::jsonb)
      `, [crypto.randomUUID(), user.id, row.application_id, `access_change.${decision}`, id, JSON.stringify(change.before), JSON.stringify(decision === "approve" ? change.after : { decision: "rejected" })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new ResearchApiError("CONFLICT", "该审批人已处理此申请", 409);
      throw error;
    } finally {
      client.release();
    }
    return Response.json({ ok: true, status });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && String(error.code) === "23505";
}

async function applyApprovedChange(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, change: AccessChange, actorId: string) {
  switch (change.changeType) {
    case "role_create": {
      const roleId = crypto.randomUUID();
      await client.query("INSERT INTO roles (id, application_id, code, name, kind, status, created_by_user_id) VALUES ($1, $2, $3, $4, 'custom', 'draft', $5)", [roleId, change.applicationId, change.after.code, change.after.name, actorId]);
      for (const permission of change.after.permissions) await client.query("INSERT INTO role_permissions (id, role_id, permission_key, scope) VALUES ($1, $2, $3, $4)", [crypto.randomUUID(), roleId, permission.permissionKey, permission.scope]);
      return;
    }
    case "role_update":
      if (!(await client.query("UPDATE roles SET name = $1, updated_at = now() WHERE id = $2 AND application_id = $3 AND is_system = false AND status = 'draft' RETURNING id", [change.after.name, change.targetRoleId, change.applicationId])).rows.length) throw new ResearchApiError("CONFLICT", "角色状态已变化", 409);
      return;
    case "role_assign":
      if (!(await client.query(`INSERT INTO user_role_assignments (id, user_id, role_id, application_id, organization_id, scope_organization_ids_json, expires_at, granted_by_user_id, reason) SELECT $1, u.id, r.id, r.application_id, u.organization_id, CASE WHEN u.organization_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(u.organization_id) END, $2::timestamptz, $3, $4 FROM users u JOIN roles r ON r.id = $5 WHERE u.id = $6 AND r.application_id = $7 AND r.status = 'published' RETURNING id`, [crypto.randomUUID(), change.after.expiresAt, actorId, change.after.reason, change.targetRoleId, change.targetUserId, change.applicationId])).rows.length) throw new ResearchApiError("CONFLICT", "用户或角色状态已变化", 409);
      await client.query("DELETE FROM rbac_revocation_tombstones WHERE user_id = $1 AND application_id = $2", [change.targetUserId, change.applicationId]);
      return;
    case "role_revoke": {
      const revoked = await client.query("UPDATE user_role_assignments SET status = 'revoked', revoked_by_user_id = $1, revoked_at = now(), updated_at = now() WHERE id = $2 AND user_id = $3 AND role_id = $4 AND application_id = $5 AND status = 'active' RETURNING id", [actorId, change.after.assignmentId, change.targetUserId, change.targetRoleId, change.applicationId]);
      if (!revoked.rows.length) throw new ResearchApiError("CONFLICT", "角色分配状态已变化", 409);
      await client.query(`
        INSERT INTO rbac_revocation_tombstones
          (id, user_id, application_id, revoked_assignment_id, revoked_role_id, revoked_by_user_id, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, application_id) DO UPDATE SET
          revoked_assignment_id = EXCLUDED.revoked_assignment_id,
          revoked_role_id = EXCLUDED.revoked_role_id,
          revoked_by_user_id = EXCLUDED.revoked_by_user_id,
          reason = EXCLUDED.reason,
          revoked_at = now()
      `, [crypto.randomUUID(), change.targetUserId, change.applicationId, change.after.assignmentId, change.targetRoleId, actorId, change.after.reason]);
      await client.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND app_audience = $2 AND revoked_at IS NULL", [change.targetUserId, change.applicationId]);
      return;
    }
    case "template_publish": {
      const templateId = crypto.randomUUID();
      await client.query("INSERT INTO role_templates (id, application_id, code, name, status, created_by_user_id) VALUES ($1, $2, $3, $4, 'published', $5)", [templateId, change.applicationId, change.after.code, change.after.name, actorId]);
      await client.query("INSERT INTO role_template_versions (id, template_id, version, permissions_json, change_summary, published_by_user_id) VALUES ($1, $2, 1, $3::jsonb, $4, $5)", [crypto.randomUUID(), templateId, JSON.stringify(change.after.permissions), change.after.changeSummary, actorId]);
    }
  }
}
