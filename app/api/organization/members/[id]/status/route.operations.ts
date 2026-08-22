import { requireAccessPermission } from "@/lib/access-control";
import { canAccessOrganization } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

type MemberStatusAction = "deactivate" | "restore";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.organization.manage");
    const { id } = await params;
    const body = await readResearchJson(request, 4_096);
    const action = body.action as MemberStatusAction;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!["deactivate", "restore"].includes(action)) throw new ResearchApiError("MEMBER_ACTION_INVALID", "成员操作无效", 422);
    if (reason.length < 3 || reason.length > 500) throw new ResearchApiError("MEMBER_REASON_INVALID", "操作原因需要 3–500 个字符", 422);
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
      }>(`SELECT id,role,status,organization_id FROM users WHERE id=$1 AND role<>'customer' FOR UPDATE`, [id])).rows[0];
      if (!member) throw new ResearchApiError("MEMBER_NOT_FOUND", "成员不存在或不在当前范围", 404);
      const inScope = member.organization_id
        ? canAccessOrganization(scope, { userId: actor.id, organizationId: actor.organizationId }, member.organization_id, organizationIds)
        : scope === "PLATFORM";
      if (!inScope || (member.role === "hq_admin" && scope !== "PLATFORM")) {
        throw new ResearchApiError("MEMBER_NOT_FOUND", "成员不存在或不在当前范围", 404);
      }
      const expected = action === "deactivate" ? "active" : "frozen";
      const nextStatus = action === "deactivate" ? "frozen" : "active";
      const auditAction = action === "deactivate" ? "organization.member_deactivated" : "organization.member_restored";
      if (member.status === nextStatus) {
        await client.query("COMMIT");
        return Response.json({ ok: true, status: nextStatus, replayed: true });
      }
      if (member.status !== expected) {
        throw new ResearchApiError("MEMBER_STATE_CONFLICT", "成员状态已变化，请刷新后重试", 409, { currentStatus: member.status });
      }
      const now = new Date();
      await client.query("UPDATE users SET status=$2,updated_at=$3 WHERE id=$1", [id, nextStatus, now]);
      if (action === "deactivate") {
        await client.query("UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL", [id, now]);
        await client.query("UPDATE auth_tokens SET used_at=$2 WHERE user_id=$1 AND used_at IS NULL", [id, now]);
      }
      await client.query(`
        INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at)
        VALUES($1,$2,$3,'user',$4,$5,$6,$7)
      `, [crypto.randomUUID(), actor.id, auditAction, id, JSON.stringify({ status: member.status }), JSON.stringify({ status: nextStatus, reason, requestId: request.headers.get("x-request-id") }), now]);
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
        message: action === "deactivate" ? "成员已停用，所有会话和未使用邀请已撤销" : "成员已恢复，可重新登录运营端",
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
