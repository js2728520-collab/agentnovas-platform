import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, communityStrategies, strategyVersions } from "@/db/schema";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { requireUser, responseError } from "@/lib/session";
import { normalizeResearchStrategyDsl, StrategyDslValidationError } from "@/lib/strategy-dsl";

const editableStatuses = ["draft", "testing", "rejected"] as const;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureD1Schema();
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    let body: { sourceVersion?: unknown };
    try {
      body = await request.json() as { sourceVersion?: unknown };
    } catch {
      return Response.json({ error: "回滚请求格式无效" }, { status: 400 });
    }
    const sourceVersion = body.sourceVersion;
    if (!Number.isInteger(sourceVersion) || Number(sourceVersion) < 1) {
      return Response.json({ error: "回滚版本号必须是正整数" }, { status: 400 });
    }

    const db = getDb();
    const current = (await db.select().from(communityStrategies).where(and(
      eq(communityStrategies.id, id),
      eq(communityStrategies.authorUserId, me.id),
    )).limit(1))[0];
    if (!current) return Response.json({ error: "策略不存在" }, { status: 404 });
    if (!editableStatuses.includes(current.status as typeof editableStatuses[number])) {
      return Response.json({ error: "策略已进入审核或运行状态，请先通过现有变更流程创建可编辑草稿" }, { status: 409 });
    }
    if (sourceVersion === current.version) {
      return Response.json({ error: "当前版本无需回滚" }, { status: 409 });
    }

    const historical = (await db.select().from(strategyVersions).where(and(
      eq(strategyVersions.strategyId, id),
      eq(strategyVersions.version, sourceVersion),
    )).limit(1))[0];
    if (!historical) return Response.json({ error: "历史版本不存在" }, { status: 404 });

    let specification;
    try {
      specification = normalizeResearchStrategyDsl(JSON.parse(historical.specificationJson));
    } catch (error) {
      const details = error instanceof StrategyDslValidationError ? error.issues : [];
      return Response.json({ error: "历史版本规则未通过当前 DSL 校验，无法回滚", details }, { status: 422 });
    }

    const nextVersion = current.version + 1;
    const now = new Date().toISOString();
    const name = historical.name.trim() || current.name;
    const summary = historical.summary.trim() || current.summary;
    const specificationJson = JSON.stringify(specification);
    await db.batch([
      db.update(communityStrategies).set({
        name,
        summary,
        symbolsJson: JSON.stringify([specification.symbol.replace(/USDT$/, "/USDT")]),
        specificationJson,
        version: nextVersion,
        status: "draft",
        validationLabel: "UNVERIFIED",
        researchRunId: null,
        researchCandidateId: null,
        rejectionReason: null,
        updatedAt: now,
      }).where(and(
        eq(communityStrategies.id, id),
        eq(communityStrategies.authorUserId, me.id),
      )),
      db.insert(strategyVersions).values({
        id: crypto.randomUUID(),
        strategyId: id,
        version: nextVersion,
        name,
        summary,
        specificationJson,
        conversationId: historical.conversationId,
        source: "manual",
        restoredFromVersion: sourceVersion,
        createdByUserId: me.id,
      }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: "strategy.version.restored",
        subjectType: "community_strategy",
        subjectId: id,
        beforeJson: JSON.stringify({ version: current.version }),
        afterJson: JSON.stringify({ version: nextVersion, restoredFromVersion: sourceVersion }),
      }),
    ]);

    return Response.json({
      id,
      status: "draft",
      version: nextVersion,
      restoredFromVersion: sourceVersion,
      message: `已将 V${sourceVersion} 恢复为新的 V${nextVersion}，原版本记录保持不变`,
    }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
