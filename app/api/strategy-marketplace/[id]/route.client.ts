import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  communityStrategies,
  strategyValidations as strategyBacktestReports,
  strategyVersions,
} from "@/db/schema";
import { AiApiError, aiErrorResponse } from "@/lib/ai-api";
import { getOwnedAiConversation, resolveStrategyVersionSource } from "@/lib/ai-conversations";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { requireUser, responseError } from "@/lib/session";
import { normalizeResearchStrategyDsl, StrategyDslValidationError } from "@/packages/domain/src/strategy-dsl";

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const db = getDb();
    const strategy = (await db.select().from(communityStrategies).where(and(
      eq(communityStrategies.id, id),
      eq(communityStrategies.authorUserId, me.id),
    )).limit(1))[0];
    if (!strategy) return Response.json({ error: "策略不存在" }, { status: 404 });

    const [versions, reports] = await Promise.all([
      db.select().from(strategyVersions)
        .where(eq(strategyVersions.strategyId, id))
        .orderBy(desc(strategyVersions.version))
        .limit(25),
      db.select().from(strategyBacktestReports)
        .where(and(
          eq(strategyBacktestReports.strategyId, id),
          eq(strategyBacktestReports.kind, "backtest"),
        ))
        .orderBy(desc(strategyBacktestReports.createdAt))
        .limit(25),
    ]);

    return Response.json({
      strategy: {
        ...strategy,
        symbols: parseJsonArray(strategy.symbolsJson),
        specification: parseJsonObject(strategy.specificationJson),
        symbolsJson: undefined,
        specificationJson: undefined,
        conversationJson: undefined,
      },
      versions: versions.map((version) => ({
        ...version,
        specification: parseJsonObject(version.specificationJson),
        specificationJson: undefined,
      })),
      backtests: reports.map((report, index) => {
        const metrics = parseJsonObject(report.metricsJson) as Record<string, unknown>;
        return {
          ...report,
          metrics: index === 0 ? metrics : { ...metrics, trades: undefined },
          metricsJson: undefined,
        };
      }),
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const db = getDb();
    const current = (await db.select().from(communityStrategies).where(and(eq(communityStrategies.id, id), eq(communityStrategies.authorUserId, me.id))).limit(1))[0];
    if (!current) return Response.json({ error: "策略不存在" }, { status: 404 });
    if (!["draft", "testing", "rejected"].includes(current.status)) return Response.json({ error: "策略已进入审核或运行状态，请通过变更流程修改" }, { status: 409 });
    const body = await request.json() as { name?: string; summary?: string; symbols?: string[]; riskLevel?: "low" | "medium" | "high"; publicationMode?: "marketplace" | "self_use"; conversationId?: string; generationId?: string; specification?: unknown };
    if (!body.name?.trim() || !body.summary?.trim()) return Response.json({ error: "策略名称和说明为必填" }, { status: 400 });
    let specification;
    try {
      specification = normalizeResearchStrategyDsl(body.specification);
    } catch (error) {
      const details = error instanceof StrategyDslValidationError ? error.issues : [];
      return Response.json({ error: "策略规则未通过 DSL 校验", details }, { status: 422 });
    }
    const conversationId = String(body.conversationId || "").trim() || null;
    if (conversationId) {
      const conversation = await getOwnedAiConversation(me.id, conversationId);
      if (conversation.purpose !== "strategy") return Response.json({ error: "当前对话不是策略研究对话" }, { status: 409 });
    }
    const now = new Date().toISOString();
    const nextVersion = current.version + 1;
    const specificationJson = JSON.stringify(specification);
    const source = await resolveStrategyVersionSource({ userId: me.id, conversationId, generationId: String(body.generationId || "").trim() || null, specificationJson });
    const changes = { name: body.name.trim(), summary: body.summary.trim(), symbolsJson: JSON.stringify([specification.symbol.replace(/USDT$/, "/USDT")]), riskLevel: body.riskLevel || "medium" as const, publicationMode: body.publicationMode === "self_use" ? "self_use" as const : "marketplace" as const, conversationJson: "[]", specificationJson, version: nextVersion, status: "draft" as const, validationLabel: "UNVERIFIED" as const, researchRunId: null, researchCandidateId: null, rejectionReason: null, updatedAt: now };
    await db.batch([
      db.update(communityStrategies).set(changes).where(eq(communityStrategies.id, id)),
      db.insert(strategyVersions).values({ id: crypto.randomUUID(), strategyId: id, version: nextVersion, name: body.name.trim(), summary: body.summary.trim(), specificationJson, conversationId, source, createdByUserId: me.id }),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: "strategy.draft.updated", subjectType: "community_strategy", subjectId: id, beforeJson: JSON.stringify({ version: current.version, specification: JSON.parse(current.specificationJson) }), afterJson: JSON.stringify({ version: nextVersion, specification, source }) }),
    ]);
    return Response.json({ id, status: "draft", version: nextVersion, message: "策略草稿已更新，可直接提交平台人工审核" });
  } catch (error) {
    if (error instanceof AiApiError) return aiErrorResponse(error);
    return responseError(error);
  }
}
