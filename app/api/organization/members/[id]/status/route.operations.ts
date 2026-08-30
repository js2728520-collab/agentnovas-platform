import { requireAccessPermission } from "@/lib/access-control";
import { canAccessOrganization } from "@/lib/operations-access";
import { automaticAuditReason } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { canIssueInternalRegistrationLink } from "@/packages/domain/src/organization-provisioning";

type MemberStatusAction = "deactivate" | "restore";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.organization.manage");
    const { id } = await params;
    const body = await readResearchJson(request, 4_096);
    const action = body.action as MemberStatusAction;
    if (!["deactivate", "restore"].includes(action)) throw new ResearchApiError("MEMBER_ACTION_INVALID", "成员操作无效", 422);
    if (id === actor.id) throw new ResearchApiError("MEMBER_SELF_ACTION_FORBIDDEN", "不能停用或恢复当前账户", 403);

    const pool = await getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const member = (await client.query<{
        id: string;
        role: string;
        status: string;
        organization_id: string | null;
        reports_to_user_id: string | null;
      }>(`SELECT id,role,status,organization_id,reports_to_user_id FROM users WHERE id=$1 AND role<>'customer' FOR UPDATE`, [id])).rows[0];
      if (!member) throw new ResearchApiError("MEMBER_NOT_FOUND", "成员不存在或不在当前范围", 404);
      const roleInScope = canIssueInternalRegistrationLink(actor.role, member.role);
      const organizationInScope = member.organization_id
        ? member.organization_id === actor.organizationId || organizationIds.includes(member.organization_id)
        : scope === "PLATFORM";
      let reportingLineInScope = scope === "PLATFORM"
        || ((scope === "ORGANIZATION" || scope === "ORGANIZATION_SET")
          && canAccessOrganization(scope, { userId: actor.id, organizationId: actor.organizationId }, member.organization_id!, organizationIds));
      if (scope === "DIRECT_REPORTS") reportingLineInScope = member.reports_to_user_id === actor.id;
      if (scope === "TEAM_TREE") {
        reportingLineInScope = Boolean((await client.query<{ allowed: boolean }>(`
          WITH RECURSIVE reporting_chain AS (
            SELECT id,reports_to_user_id,1 AS depth FROM users WHERE id=$1
            UNION ALL
            SELECT manager.id,manager.reports_to_user_id,chain.depth+1
              FROM users manager
              JOIN reporting_chain chain ON manager.id=chain.reports_to_user_id
             WHERE chain.depth<16
          )
          SELECT EXISTS(SELECT 1 FROM reporting_chain WHERE id=$2 AND depth>1) AS allowed
        `, [member.id, actor.id])).rows[0]?.allowed);
      }
      if (!roleInScope || !organizationInScope || !reportingLineInScope) {
        throw new ResearchApiError("MEMBER_NOT_FOUND", "成员不存在或不在当前范围", 404);
      }
      const expected = action === "deactivate" ? "active" : "frozen";
      const nextStatus = action === "deactivate" ? "frozen" : "active";
      const auditAction = action === "deactivate" ? "organization.member_deactivated" : "organization.member_restored";
      const reason = automaticAuditReason(auditAction);
      if (member.status === nextStatus) {
        await client.query("COMMIT");
        return Response.json({ ok: true, status: nextStatus, replayed: true });
      }
      if (member.status !== expected) {
        throw new ResearchApiError("MEMBER_STATE_CONFLICT", "成员状态已变化，请刷新后重试", 409, { currentStatus: member.status });
      }
      const now = new Date();
      let revokedRegistrationLinks = 0;
      await client.query("UPDATE users SET status=$2,updated_at=$3 WHERE id=$1", [id, nextStatus, now]);
      if (action === "deactivate") {
        await client.query("UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL", [id, now]);
        await client.query("UPDATE auth_tokens SET used_at=$2 WHERE user_id=$1 AND used_at IS NULL", [id, now]);
        const revoked = await client.query(`
          UPDATE internal_registration_links
             SET status='revoked',revoked_at=$2,revoked_by_user_id=$3,updated_at=$2
           WHERE issuer_user_id=$1 AND status='active'
          RETURNING id
        `, [id, now, actor.id]);
        revokedRegistrationLinks = revoked.rowCount ?? 0;
      }
      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at)
        VALUES($1,$2,$3,'user',$4,$5,$6,$7)
      `, [crypto.randomUUID(), actor.id, auditAction, id, JSON.stringify({ status: member.status }), JSON.stringify({ status: nextStatus, reason, auditSource: "automatic", revokedRegistrationLinks, requestId: request.headers.get("x-request-id") }), now]);
      await client.query(`
        INSERT INTO notification_deliveries(id,user_id,channel,category,template_key,payload_json,status,scheduled_at,dedupe_key)
        VALUES($1,$2,'in_app','login_security',$3,$4,'queued',$5,$6)
        ON CONFLICT(dedupe_key) DO NOTHING
      `, [crypto.randomUUID(), id, `internal_member_${action}`, JSON.stringify({ status: nextStatus }), now, `internal-member-status:${id}:${nextStatus}:${now.toISOString()}`]);
      await client.query("COMMIT");
      return Response.json({
        ok: true,
        status: nextStatus,
        replayed: false,
        message: action === "deactivate" ? "成员已停用，所有会话、未使用令牌和有效权限链接已撤销" : "成员已恢复，可重新登录运营端",
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
