import { requireCurrentAccessAdmin, requireCurrentAccessAssignmentAdmin, requireCurrentAccessViewer } from "@/lib/access-control";
import { accessPageCursor, accessUserScopePredicate, parseAccessPageCursor, scopeCanDelegate } from "@/lib/access-center-scope";
import { lockScopedRoleForTarget } from "@/lib/access-role-authorization";
import { parseAccessChangeRequest } from "@/lib/access-change-requests";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const requestStatuses = new Set(["pending", "approved", "rejected", "cancelled"]);

export async function GET(request: Request) {
  try {
    const { appId, user, access, scope, organizationIds } = await requireCurrentAccessViewer(request);
    const canApprove = appId === "operations"
      ? Boolean(access.permissions["ops.roles.manage"] || access.permissions["ops.roles.approve_sensitive"])
      : Boolean(access.permissions["maint.roles.manage"] || access.permissions["maint.roles.approve_sensitive"]);
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "pending";
    if (status && !requestStatuses.has(status)) {
      throw new ResearchApiError("VALIDATION_ERROR", "权限申请状态无效", 422, { fields: ["status"] });
    }
    const requestedLimit = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;
    const cursor = parseAccessPageCursor(url.searchParams.get("cursor"));
    const values: unknown[] = [appId, status];
    const scopePredicate = accessUserScopePredicate({
      scope,
      actor: { id: user.id, organizationId: user.organizationId },
      organizationIds,
      userAlias: "target",
      startIndex: values.length + 1,
    });
    values.push(...scopePredicate.values);
    const cursorClause = cursor
      ? `(acr.requested_at, acr.id) < ($${values.push(cursor.createdAt)}::timestamptz, $${values.push(cursor.id)})`
      : "TRUE";
    const limitIndex = values.push(limit + 1);
    const pool = await getPostgresPool();
    const result = await pool.query<{
      id: string; application_id: string; target_user_id: string | null; target_role_id: string | null;
      change_type: string; before_json: unknown; after_json: unknown; status: string;
      requested_by_user_id: string; requested_at: Date; completed_at: Date | null; reason: string;
      target_email: string | null; target_role_name: string | null; requester_email: string | null; decisions: unknown;
    }>(`
      SELECT acr.id, acr.application_id, acr.target_user_id, acr.target_role_id,
             acr.change_type, acr.before_json, acr.after_json, acr.status,
             acr.requested_by_user_id, acr.requested_at, acr.completed_at, acr.reason,
             target.email AS target_email, role.name AS target_role_name,
             requester.email AS requester_email,
             COALESCE(jsonb_agg(jsonb_build_object(
               'id', acd.id, 'reviewerUserId', acd.reviewer_user_id,
               'decision', acd.decision, 'note', acd.note, 'createdAt', acd.created_at
             ) ORDER BY acd.created_at) FILTER (WHERE acd.id IS NOT NULL), '[]'::jsonb) AS decisions
      FROM access_change_requests AS acr
      INNER JOIN users AS requester ON requester.id = acr.requested_by_user_id
      LEFT JOIN users AS target ON target.id = acr.target_user_id
      LEFT JOIN roles AS role ON role.id = acr.target_role_id
      LEFT JOIN access_change_decisions AS acd ON acd.request_id = acr.id
      WHERE acr.application_id = $1 AND acr.status = $2
        AND (${scope === "PLATFORM" ? "TRUE" : `(acr.target_user_id IS NOT NULL AND (${scopePredicate.clause}))`})
        AND ${cursorClause}
      GROUP BY acr.id, target.email, role.name, requester.email
      ORDER BY acr.requested_at DESC, acr.id DESC
      LIMIT $${limitIndex}
    `, values);
    const page = result.rows.slice(0, limit);
    const next = result.rows.length > limit ? page.at(-1) : null;
    return Response.json({
      changeRequests: page.map((row) => ({
        id: row.id,
        applicationId: row.application_id,
        targetUserId: row.target_user_id,
        targetUserEmail: row.target_email,
        targetRoleId: row.target_role_id,
        targetRoleName: row.target_role_name,
        changeType: row.change_type,
        before: row.before_json,
        after: row.after_json,
        status: row.status,
        reason: row.reason,
        requestedBy: { userId: row.requested_by_user_id, email: row.requester_email },
        requestedAt: row.requested_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
        decisions: row.decisions,
        canReview: canApprove && row.status === "pending" && row.requested_by_user_id !== user.id,
      })),
      nextCursor: next ? accessPageCursor({ createdAt: next.requested_at.toISOString(), id: next.id }) : null,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const viewer = await requireCurrentAccessViewer(request);
    const body = await readResearchJson(request);
    const change = parseAccessChangeRequest(body);
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new ResearchApiError("VALIDATION_ERROR", "必须填写权限变更原因", 422, { fields: ["reason"] });
    const authorization = change.changeType === "role_assign" || change.changeType === "role_revoke"
      ? await requireCurrentAccessAssignmentAdmin(request)
      : await requireCurrentAccessAdmin(request);
    const { user, appId, scope, organizationIds } = authorization;
    if (viewer.appId !== appId || viewer.user.id !== user.id) throw new ResearchApiError("FORBIDDEN", "授权上下文已变化", 403);
    if (change.applicationId !== appId) throw new ResearchApiError("FORBIDDEN", "不能提交其他应用的权限变更", 403);
    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
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
        if (!target.rows[0]) throw new ResearchApiError("FORBIDDEN", "不能变更授权范围外的用户", 403);
        targetOrganizationId = target.rows[0].organization_id;
      } else if (scope !== "PLATFORM") {
        throw new ResearchApiError("FORBIDDEN", "应用级角色变更需要平台范围授权", 403);
      }
      // Validate and lock every reference before creating an actionable request.
      if (change.changeType === "role_assign") {
        const role = await lockScopedRoleForTarget(client, {
          roleId: change.targetRoleId,
          appId: change.applicationId,
          targetOrganizationId: targetOrganizationId ?? null,
          scope,
          actor: { id: user.id, organizationId: user.organizationId },
          organizationIds,
        });
        if (!role) throw new ResearchApiError("FORBIDDEN", "不能申请授权范围外或不适用于目标组织的角色", 403);
        const roleScopes = await client.query<{ scope: Parameters<typeof scopeCanDelegate>[1] }>(`
          SELECT scope FROM role_permissions WHERE role_id = $1
        `, [change.targetRoleId]);
        if (roleScopes.rows.some((permission) => !scopeCanDelegate(scope, permission.scope))) {
          throw new ResearchApiError("SCOPE_ESCALATION", "不能申请分配数据范围大于自身授权的角色", 403);
        }
      } else if (change.changeType === "role_update") {
        const result = await client.query("SELECT id FROM roles WHERE id = $1 AND application_id = $2 AND is_system = false FOR UPDATE", [change.targetRoleId, change.applicationId]);
        if (!result.rows[0]) throw new Error("ACCESS_REFERENCE_NOT_FOUND");
      } else if (change.changeType === "role_revoke") {
        const result = await client.query(`
          SELECT ura.id FROM user_role_assignments ura
          JOIN roles r ON r.id = ura.role_id
          WHERE ura.id = $1 AND ura.user_id = $2 AND r.id = $3
            AND ura.application_id = $4 AND ura.status = 'active'
          FOR UPDATE OF ura, r
        `, [change.after.assignmentId, change.targetUserId, change.targetRoleId, change.applicationId]);
        if (!result.rows[0]) throw new Error("ACCESS_REFERENCE_NOT_FOUND");
      }
      const result = await client.query(`
        INSERT INTO access_change_requests
          (id, application_id, target_user_id, target_role_id, change_type, before_json, after_json, requested_by_user_id, reason)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
        RETURNING id, application_id, change_type, status, requested_at
      `, [crypto.randomUUID(), change.applicationId, change.targetUserId, change.targetRoleId,
        change.changeType, JSON.stringify(change.before), JSON.stringify(change.after), user.id,
        reason]);
      await client.query("COMMIT");
      return Response.json({ changeRequest: result.rows[0] }, { status: 201 });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof Error && error.message === "ACCESS_REFERENCE_NOT_FOUND") {
      return Response.json({ error: { code: "NOT_FOUND", message: "目标不存在、应用不匹配或状态不允许", details: {} } }, { status: 404 });
    }
    return researchErrorResponse(error);
  }
}
