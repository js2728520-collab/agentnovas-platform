import { requireAccessPermission } from "@/lib/access-control";
import { canAccessOrganization } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

const reportingHierarchy: Record<string, string> = {
  manager: "branch_admin",
  supervisor: "manager",
  employee: "supervisor",
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user: actor, scope, organizationIds } = await requireAccessPermission(request, "ops.approvals.decide");
    const { id } = await params;
    const body = await readResearchJson(request, 4_096);
    const decision = body.decision;
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (decision !== "approve" && decision !== "reject") throw new ResearchApiError("APPROVAL_DECISION_INVALID", "审批决定无效", 422);
    if (note.length < 3 || note.length > 500) throw new ResearchApiError("APPROVAL_NOTE_INVALID", "审批说明需要 3–500 个字符", 422);

    const client = await (await getPostgresPool()).connect();
    try {
      await client.query("BEGIN");
      const approval = (await client.query<{
        id: string;
        type: string;
        branch_id: string | null;
        subject_id: string;
        payload_json: string;
        status: string;
        requested_by: string;
      }>("SELECT id,type,branch_id,subject_id,payload_json,status,requested_by FROM approval_requests WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!approval) throw new ResearchApiError("APPROVAL_NOT_FOUND", "审批单不存在或不在当前范围", 404);
      if (approval.type !== "reporting_line_change") throw new ResearchApiError("LEGACY_APPROVAL_DISABLED", "该遗留审批类型在商用 Paper 版本中已停用", 503);
      const inScope = approval.branch_id
        ? canAccessOrganization(scope, { userId: actor.id, organizationId: actor.organizationId }, approval.branch_id, organizationIds)
        : scope === "PLATFORM";
      if (!inScope) throw new ResearchApiError("APPROVAL_NOT_FOUND", "审批单不存在或不在当前范围", 404);
      if (approval.requested_by === actor.id) throw new ResearchApiError("MAKER_CHECKER_REQUIRED", "申请人不能审批自己的申请", 403);

      const existing = (await client.query<{ decision: string }>("SELECT decision FROM approval_decisions WHERE request_id=$1 AND reviewer_id=$2 FOR SHARE", [id, actor.id])).rows[0];
      if (existing) {
        if (existing.decision !== decision) throw new ResearchApiError("APPROVAL_ALREADY_DECIDED", "你已经以不同结论处理该申请", 409);
        await client.query("COMMIT");
        return Response.json({ status: approval.status, replayed: true });
      }
      if (approval.status !== "pending") throw new ResearchApiError("APPROVAL_STATE_CONFLICT", "审批单已经结束", 409, { status: approval.status });
      await client.query("INSERT INTO approval_decisions(id,request_id,reviewer_id,decision,note) VALUES($1,$2,$3,$4,$5)", [crypto.randomUUID(), id, actor.id, decision, note]);
      const now = new Date();
      if (decision === "reject") {
        await client.query("UPDATE approval_requests SET status='rejected',completed_at=$2 WHERE id=$1", [id, now]);
        await client.query("INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,created_at) VALUES($1,$2,'reporting_line_change.rejected','user',$3,$4,$5)", [crypto.randomUUID(), actor.id, approval.subject_id, JSON.stringify({ approvalId: id, note }), now]);
        await client.query("COMMIT");
        return Response.json({ status: "rejected", replayed: false });
      }
      const approvals = Number((await client.query<{ count: string }>("SELECT count(*)::text AS count FROM approval_decisions WHERE request_id=$1 AND decision='approve'", [id])).rows[0]?.count ?? 0);
      const payload = JSON.parse(approval.payload_json || "{}") as Record<string, unknown>;
      const previousReportsToUserId = typeof payload.previousReportsToUserId === "string" ? payload.previousReportsToUserId : null;
      const newReportsToUserId = typeof payload.newReportsToUserId === "string" ? payload.newReportsToUserId : "";
      if (!newReportsToUserId || payload.newRole) throw new ResearchApiError("REPORTING_CHANGE_INVALID", "汇报关系申请快照无效", 409);
      const members = await client.query<{ id: string; role: string; status: string; organization_id: string | null; reports_to_user_id: string | null }>("SELECT id,role,status,organization_id,reports_to_user_id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [[approval.subject_id, newReportsToUserId]]);
      const member = members.rows.find((row) => row.id === approval.subject_id);
      const leader = members.rows.find((row) => row.id === newReportsToUserId);
      if (!member || !leader || member.status !== "active" || leader.status !== "active" || !member.organization_id || member.organization_id !== leader.organization_id) {
        throw new ResearchApiError("REPORTING_CHANGE_STALE", "成员或上级状态已变化，请重新提交", 409);
      }
      if (member.reports_to_user_id !== previousReportsToUserId || reportingHierarchy[member.role] !== leader.role) {
        throw new ResearchApiError("REPORTING_CHANGE_STALE", "当前汇报关系或组织层级已变化，请重新提交", 409);
      }
      await client.query("UPDATE users SET reports_to_user_id=$2,updated_at=$3 WHERE id=$1", [member.id, leader.id, now]);
      await client.query("UPDATE approval_requests SET status='approved',completed_at=$2 WHERE id=$1", [id, now]);
      await client.query("INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,before_json,after_json,created_at) VALUES($1,$2,'reporting_line_change.approved','user',$3,$4,$5,$6)", [crypto.randomUUID(), actor.id, member.id, JSON.stringify({ reportsToUserId: previousReportsToUserId }), JSON.stringify({ reportsToUserId: leader.id, approvalId: id, reviewers: approvals }), now]);
      await client.query("COMMIT");
      return Response.json({ status: "approved", effective: true, approvals, required: 1, replayed: false });
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
