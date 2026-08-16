import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, communityStrategies, strategyVersions } from "@/db/schema";
import { getOwnedAiConversation } from "@/lib/ai-conversations";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { requireUser, responseError } from "@/lib/session";
import { normalizeStrategyDsl, StrategyDslValidationError } from "@/lib/strategy-dsl";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureD1Schema();
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const db = getDb();
    const current = (await db.select().from(communityStrategies).where(and(eq(communityStrategies.id, id), eq(communityStrategies.authorUserId, me.id))).limit(1))[0];
    if (!current) return Response.json({ error: "策略不存在" }, { status: 404 });
    if (!["draft", "testing", "rejected"].includes(current.status)) return Response.json({ error: "策略已进入审核或运行状态，请通过变更流程修改" }, { status: 409 });
    const body = await request.json() as { name?: string; summary?: string; symbols?: string[]; riskLevel?: "low" | "medium" | "high"; publicationMode?: "marketplace" | "self_use"; conversationId?: string; generationMode?: "ai_provider" | "guided_rules"; specification?: unknown };
    if (!body.name?.trim() || !body.summary?.trim()) return Response.json({ error: "策略名称和说明为必填" }, { status: 400 });
    let specification;
    try {
      specification = normalizeStrategyDsl(body.specification);
    } catch (error) {
      const details = error instanceof StrategyDslValidationError ? error.issues : [];
      return Response.json({ error: "策略规则未通过 DSL 校验", details }, { status: 422 });
    }
    const conversationId = String(body.conversationId || "").trim() || null;
    if (conversationId) await getOwnedAiConversation(me.id, conversationId);
    const now = new Date().toISOString();
    const nextVersion = current.version + 1;
    const source = body.generationMode === "ai_provider" || body.generationMode === "guided_rules" ? body.generationMode : "manual";
    const changes = { name: body.name.trim(), summary: body.summary.trim(), symbolsJson: JSON.stringify([specification.symbol.replace(/USDT$/, "/USDT")]), riskLevel: body.riskLevel || "medium" as const, publicationMode: body.publicationMode === "self_use" ? "self_use" as const : "marketplace" as const, conversationJson: "[]", specificationJson: JSON.stringify(specification), version: nextVersion, status: "draft" as const, rejectionReason: null, updatedAt: now };
    await db.batch([
      db.update(communityStrategies).set(changes).where(eq(communityStrategies.id, id)),
      db.insert(strategyVersions).values({ id: crypto.randomUUID(), strategyId: id, version: nextVersion, name: body.name.trim(), summary: body.summary.trim(), specificationJson: JSON.stringify(specification), conversationId, source, createdByUserId: me.id }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: "strategy.draft.updated", subjectType: "community_strategy", subjectId: id, beforeJson: JSON.stringify({ version: current.version, specification: JSON.parse(current.specificationJson) }), afterJson: JSON.stringify({ version: nextVersion, specification, source }) }),
    ]);
    return Response.json({ id, status: "draft", version: nextVersion, message: "策略草稿已更新，可直接提交平台人工审核" });
  } catch (error) {
    return responseError(error);
  }
}
