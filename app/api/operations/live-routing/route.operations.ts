import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { approvalRequests, auditLogs } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";
import { listLiveRouting, requestLiveRouting } from "@/lib/execution/live-routing-admin";

/**
 * 实盘路由授权：查看与申请开通。
 *
 * 申请**不生效**，需要另一位运营批准（见 [id] 的 PATCH）。开通是把风险放回去的
 * 方向，因此比关停难做——这与熔断开关的不对称是同一条原则的两面。
 */

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "ops.trading.manage");
    return Response.json({ grants: await listLiveRouting() });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.trading.manage");
    const body = await request.json().catch(() => ({})) as {
      exchange?: string; environment?: string; note?: string;
    };
    const exchange = body.exchange?.trim().toLowerCase();
    if (!exchange) return Response.json({ error: "请填写交易所代号" }, { status: 400 });
    if (body.environment !== "demo" && body.environment !== "live") {
      return Response.json({ error: "环境必须是 demo 或 live" }, { status: 400 });
    }
    const note = body.note?.trim();
    // 开通实盘的理由必须写下来：事后复盘时「当初为什么开的」是第一个要问的问题。
    if (!note) return Response.json({ error: "请填写开通理由" }, { status: 400 });

    const approvalId = crypto.randomUUID();
    const db = getDb();
    await db.insert(approvalRequests).values({
      id: approvalId,
      type: "execution_live_routing_grant",
      subjectType: "execution_live_routing",
      subjectId: `${exchange}:${body.environment}`,
      payloadJson: JSON.stringify({ exchange, environment: body.environment, note }),
      requestedBy: user.id,
    });
    const result = await requestLiveRouting({
      exchange, environment: body.environment, requestedBy: user.id, note, approvalRequestId: approvalId,
    });
    if ("conflict" in result) {
      await db.delete(approvalRequests).where(eq(approvalRequests.id, approvalId));
      return Response.json({ error: "该交易所与环境已有待批准或已生效的授权" }, { status: 409 });
    }
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: "execution.live_routing.requested",
      subjectType: "execution_live_routing",
      subjectId: result.id,
      afterJson: JSON.stringify({ exchange, environment: body.environment, note, approvalRequestId: approvalId }),
    });
    return Response.json({ id: result.id, status: "pending" }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
