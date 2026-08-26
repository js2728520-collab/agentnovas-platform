import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { requireAccessPermission } from "@/lib/access-control";
import { responseError } from "@/lib/session";
import { engageKillSwitch, listKillSwitches } from "@/lib/execution/kill-switch-admin";

/**
 * 熔断开关：查看与挂起。
 *
 * 挂起是**单人即时生效**的，刻意不走 maker/checker——出事的时候没有时间等第二个人
 * 批准。摘除才需要复核，见 [id]/release。
 */

const DIMENSIONS = new Set(["exchange", "account", "strategy"]);

export async function GET(request: Request) {
  try {
    await requireAccessPermission(request, "ops.trading.manage");
    const url = new URL(request.url);
    return Response.json({
      switches: await listKillSwitches({ activeOnly: url.searchParams.get("active") === "true" }),
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAccessPermission(request, "ops.trading.manage");
    const body = await request.json().catch(() => ({})) as {
      dimension?: string; scopeValue?: string; reason?: string;
    };
    if (!body.dimension || !DIMENSIONS.has(body.dimension)) {
      return Response.json({ error: "维度必须是 exchange、account 或 strategy" }, { status: 400 });
    }
    const scopeValue = body.scopeValue?.trim();
    const reason = body.reason?.trim();
    if (!scopeValue) return Response.json({ error: "请填写要暂停的对象" }, { status: 400 });
    // 原因必填：一个没有理由的熔断，事后没人知道能不能摘。
    if (!reason) return Response.json({ error: "请填写熔断原因" }, { status: 400 });

    const result = await engageKillSwitch({
      dimension: body.dimension as "exchange" | "account" | "strategy",
      scopeValue,
      reason,
      engagedBy: user.id,
    });
    await getDb().insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: user.id,
      action: result.created ? "execution.kill_switch.engaged" : "execution.kill_switch.already_engaged",
      subjectType: "execution_kill_switch",
      subjectId: result.id,
      afterJson: JSON.stringify({ dimension: body.dimension, scopeValue, reason }),
    });
    return Response.json({ id: result.id, created: result.created }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return responseError(error);
  }
}
