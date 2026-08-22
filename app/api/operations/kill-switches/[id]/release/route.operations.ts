import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvalRequests, auditLogs } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";
import { applyKillSwitchRelease, requestKillSwitchRelease } from "@/lib/execution/kill-switch-admin";

/**
 * 熔断摘除：走 maker/checker。
 *
 * POST 发起解除申请（开关**仍然生效**）；PATCH 由另一个人批准后才真正解除。
 * 恢复交易是把风险放回去，这才是需要第二双眼睛的方向。
 */

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "ops.trading.manage");
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { note?: string };

    const approvalId = crypto.randomUUID();
    const db = getDb();
    await db.insert(approvalRequests).values({
      id: approvalId,
      type: "execution_kill_switch_release",
      subjectType: "execution_kill_switch",
      subjectId: id,
      payloadJson: JSON.stringify({ note: body.note?.trim() || "" }),
      requestedBy: user.id,
    });
    const result = await requestKillSwitchRelease({
      id, requestedBy: user.id, approvalRequestId: approvalId,
    });
    if (!result.requested) {
      // 申请没落上就把审批单撤掉，否则运维端会看到一张永远批不动的单。
      await db.delete(approvalRequests).where(eq(approvalRequests.id, approvalId));
      return Response.json({ error: "该熔断不存在、已解除，或已有待批准的解除申请" }, { status: 409 });
    }
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "execution.kill_switch.release_requested",
      subjectType: "execution_kill_switch",
      subjectId: id,
      afterJson: JSON.stringify({ approvalRequestId: approvalId }),
    });
    return Response.json({ approvalRequestId: approvalId, status: "pending" }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "ops.trading.manage");
    const { id } = await context.params;

    // 发起人自己批准自己等于没有 maker/checker。仓储层用 SQL 再挡一次——
    // 这条规则的代价太高，不该只靠一层。
    const result = await applyKillSwitchRelease({ id, releasedBy: user.id });
    if (!result.released) {
      const status = result.reason === "KILL_SWITCH_SELF_APPROVAL_FORBIDDEN" ? 403 : 409;
      return Response.json({ code: result.reason, error: describeReleaseFailure(result.reason) }, { status });
    }
    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "execution.kill_switch.released",
      subjectType: "execution_kill_switch",
      subjectId: id,
      afterJson: JSON.stringify({ releasedBy: user.id }),
    });
    return Response.json({ id, active: false });
  } catch (error) {
    return responseError(error);
  }
}

function describeReleaseFailure(reason: string | undefined) {
  if (reason === "KILL_SWITCH_SELF_APPROVAL_FORBIDDEN") return "解除申请必须由另一位运营批准";
  if (reason === "KILL_SWITCH_RELEASE_NOT_REQUESTED") return "请先发起解除申请";
  if (reason === "KILL_SWITCH_ALREADY_RELEASED") return "该熔断已解除";
  return "熔断不存在";
}
