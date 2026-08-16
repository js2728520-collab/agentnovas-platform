import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  communityStrategies,
  strategySubscriptions,
  strategyVersions,
  strategyValidations as strategyBacktestReports,
  users,
} from "@/db/schema";
import { getOwnedAiConversation } from "@/lib/ai-conversations";
import { ensureD1Schema } from "@/lib/d1-migrations";
import { currentUser, requireUser, responseError } from "@/lib/session";
import { normalizeStrategyDsl, StrategyDslValidationError } from "@/lib/strategy-dsl";

function parseArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  try {
    await ensureD1Schema();
    const me = await currentUser(request);
    const db = getDb();
    const fields = {
      id: communityStrategies.id,
      name: communityStrategies.name,
      summary: communityStrategies.summary,
      riskLevel: communityStrategies.riskLevel,
      symbolsJson: communityStrategies.symbolsJson,
      version: communityStrategies.version,
      publishedAt: communityStrategies.publishedAt,
      featuredRank: communityStrategies.featuredRank,
      rankingScore: communityStrategies.rankingScore,
      authorEmail: users.email,
      authorNickname: users.nickname,
      authorUsername: users.username,
      authorAvatarUrl: users.avatarUrl,
      authorRole: users.role,
      publicationMode: communityStrategies.publicationMode,
    };
    const all = await db
      .select(fields)
      .from(communityStrategies)
      .innerJoin(users, eq(users.id, communityStrategies.authorUserId))
      .where(and(eq(communityStrategies.status, "published"), eq(communityStrategies.publicationMode, "marketplace")))
      .orderBy(asc(communityStrategies.featuredRank), desc(communityStrategies.rankingScore), desc(communityStrategies.publishedAt))
      .limit(60);
    const featured = all
      .filter((row) => row.featuredRank != null)
      .sort((a, b) => Number(a.featuredRank) - Number(b.featuredRank))
      .slice(0, 3);
    const featuredIds = new Set(featured.map((row) => row.id));
    const published = [
      ...featured,
      ...all.filter((row) => !featuredIds.has(row.id)).sort((a, b) => Number(b.rankingScore) - Number(a.rankingScore)),
    ];
    let mine: Array<typeof communityStrategies.$inferSelect> = [];
    if (me) {
      mine = await db
        .select()
        .from(communityStrategies)
        .where(eq(communityStrategies.authorUserId, me.id))
        .orderBy(desc(communityStrategies.updatedAt));
    }
    const ids = [...published.map((row) => row.id), ...mine.map((row) => row.id)];
    const backtests = ids.length
      ? await db.select().from(strategyBacktestReports).where(and(
          inArray(strategyBacktestReports.strategyId, ids),
          eq(strategyBacktestReports.kind, "backtest"),
        ))
      : [];
    const followers = ids.length
      ? await db
          .select({
            strategyId: strategySubscriptions.strategyId,
            count: sql<number>`count(distinct ${strategySubscriptions.customerId})`,
          })
          .from(strategySubscriptions)
          .where(and(inArray(strategySubscriptions.strategyId, ids), eq(strategySubscriptions.status, "active")))
          .groupBy(strategySubscriptions.strategyId)
      : [];
    const followerMap = new Map(followers.map((row) => [row.strategyId, Number(row.count)]));
    return Response.json({
      featuredCount: featured.length,
      published: published.map((row) => ({
        ...row,
        symbols: parseArray(row.symbolsJson),
        backtests: backtests.filter((report) => report.strategyId === row.id),
        activeFollowers: followerMap.get(row.id) || 0,
      })),
      mine: mine.map((row) => ({
        ...row,
        symbols: parseArray(row.symbolsJson),
        conversation: parseArray(row.conversationJson),
        specification: parseObject(row.specificationJson),
        backtests: backtests.filter((report) => report.strategyId === row.id),
      })),
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureD1Schema();
    const me = await requireUser(request, ["customer"]);
    const body = (await request.json()) as {
      name?: string;
      summary?: string;
      symbols?: string[];
      riskLevel?: "low" | "medium" | "high";
      publicationMode?: "marketplace" | "self_use";
      conversationId?: string;
      generationMode?: "ai_provider" | "guided_rules";
      specification?: unknown;
    };
    if (!body.name?.trim() || !body.summary?.trim()) {
      return Response.json({ error: "策略名称和说明为必填" }, { status: 400 });
    }
    let specification;
    try {
      specification = normalizeStrategyDsl(body.specification);
    } catch (error) {
      const details = error instanceof StrategyDslValidationError ? error.issues : [];
      return Response.json({ error: "策略规则未通过 DSL 校验", details }, { status: 422 });
    }
    const conversationId = String(body.conversationId || "").trim() || null;
    if (conversationId) await getOwnedAiConversation(me.id, conversationId);
    const symbols = [specification.symbol.replace(/USDT$/, "/USDT")];
    const riskLevel = ["low", "medium", "high"].includes(String(body.riskLevel))
      ? body.riskLevel!
      : "medium";
    const publicationMode = body.publicationMode === "self_use" ? "self_use" : "marketplace";
    const source = body.generationMode === "ai_provider" || body.generationMode === "guided_rules"
      ? body.generationMode
      : "manual";
    const id = crypto.randomUUID();
    await getDb().batch([
      getDb().insert(communityStrategies).values({
        id,
        authorUserId: me.id,
        name: body.name.trim(),
        summary: body.summary.trim(),
        symbolsJson: JSON.stringify(symbols),
        riskLevel,
        publicationMode,
        conversationJson: "[]",
        specificationJson: JSON.stringify(specification),
      }),
      getDb().insert(strategyVersions).values({
        id: crypto.randomUUID(),
        strategyId: id,
        version: 1,
        name: body.name.trim(),
        summary: body.summary.trim(),
        specificationJson: JSON.stringify(specification),
        conversationId,
        source,
        createdByUserId: me.id,
      }),
      getDb().insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: "strategy.draft.created",
        subjectType: "community_strategy",
        subjectId: id,
        afterJson: JSON.stringify({ name: body.name.trim(), symbols, riskLevel, publicationMode, version: 1, source, schemaVersion: specification.schemaVersion }),
      }),
    ]);
    return Response.json({ id, status: "draft", version: 1, message: "策略草稿已保存" }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
