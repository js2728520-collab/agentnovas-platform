import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, communityStrategies } from "@/db/schema";
import { requireUser, responseError } from "@/lib/session";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const db = getDb();
    const current = (await db.select().from(communityStrategies).where(and(eq(communityStrategies.id, id), eq(communityStrategies.authorUserId, me.id))).limit(1))[0];
    if (!current) return Response.json({ error: "策略不存在" }, { status: 404 });
    if (!["draft", "testing", "rejected"].includes(current.status)) return Response.json({ error: "策略已进入审核或运行状态，请通过变更流程修改" }, { status: 409 });
    const body = await request.json() as { name?: string; summary?: string; symbols?: string[]; riskLevel?: "low" | "medium" | "high"; conversation?: unknown[]; specification?: Record<string, unknown> };
    if (!body.name?.trim() || !body.summary?.trim()) return Response.json({ error: "策略名称和说明为必填" }, { status: 400 });
    const now = new Date().toISOString();
    const changes = { name: body.name.trim(), summary: body.summary.trim(), symbolsJson: JSON.stringify(body.symbols || []), riskLevel: body.riskLevel || "medium" as const, conversationJson: JSON.stringify(body.conversation || []), specificationJson: JSON.stringify(body.specification || {}), version: current.version + 1, status: "draft" as const, rejectionReason: null, updatedAt: now };
    await db.batch([
      db.update(communityStrategies).set(changes).where(eq(communityStrategies.id, id)),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: "strategy.draft.updated", subjectType: "community_strategy", subjectId: id, beforeJson: JSON.stringify({ version: current.version, specification: JSON.parse(current.specificationJson) }), afterJson: JSON.stringify({ version: changes.version, specification: body.specification || {} }) }),
    ]);
    return Response.json({ id, status: "draft", version: changes.version, message: "策略草稿已更新，可直接提交平台人工审核" });
  } catch (error) {
    return responseError(error);
  }
}
