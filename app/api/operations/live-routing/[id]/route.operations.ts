import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";
import { grantLiveRouting, revokeLiveRouting } from "@/lib/execution/live-routing-admin";
import { isLiveExecutionReady } from "@/packages/domain/src/execution/live-readiness";

/**
 * PATCH 批准开通（必须由另一位运营），DELETE 关停（单人即时）。
 *
 * 这条不对称是刻意的：让系统更安全的动作永远比让系统更危险的动作容易做。
 */

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "ops.trading.manage");
    if (!isLiveExecutionReady()) {
      return Response.json({
        code: "LIVE_EXECUTION_NOT_READY",
        error: "实盘安全闸门尚未通过，不能批准开通路由",
      }, { status: 503 });
    }
    const { id } = await context.params;
    const result = await grantLiveRouting({ id, grantedBy: user.id });
    if (!result.granted) {
      const status = result.reason === "LIVE_ROUTING_SELF_APPROVAL_FORBIDDEN" ? 403 : 409;
      return Response.json({ code: result.reason, error: describeGrantFailure(result.reason) }, { status });
    }
    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "execution.live_routing.granted",
      subjectType: "execution_live_routing",
      subjectId: id,
      afterJson: JSON.stringify({ grantedBy: user.id }),
    });
    return Response.json({ id, status: "granted" });
  } catch (error) {
    return responseError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireAccessPermission(request, "ops.trading.manage");
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { reason?: string };
    const reason = body.reason?.trim();
    if (!reason) return Response.json({ error: "请填写关停原因" }, { status: 400 });

    const result = await revokeLiveRouting({ id, revokedBy: user.id, reason });
    if (!result.revoked) return Response.json({ error: "该授权不存在或已关停" }, { status: 409 });
    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "execution.live_routing.revoked",
      subjectType: "execution_live_routing",
      subjectId: id,
      afterJson: JSON.stringify({ revokedBy: user.id, reason }),
    });
    return Response.json({ id, status: "revoked" });
  } catch (error) {
    return responseError(error);
  }
}

function describeGrantFailure(reason: string | undefined) {
  if (reason === "LIVE_ROUTING_SELF_APPROVAL_FORBIDDEN") return "开通申请必须由另一位运营批准";
  if (reason === "LIVE_ROUTING_NOT_PENDING") return "该申请已批准或已关停";
  return "申请不存在";
}
