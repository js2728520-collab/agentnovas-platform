import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLogs, communityStrategies, strategyVersions } from "@/db/schema";
import { normalizeResearchStrategyDsl, type ResearchStrategyDsl } from "@/lib/strategy-dsl";

type StrategyDraftSource = "manual" | "ai_provider" | "guided_rules";

export async function createStrategyDraft(options: {
  id?: string;
  userId: string;
  name: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  publicationMode: "marketplace" | "self_use";
  specification: ResearchStrategyDsl;
  conversationId: string | null;
  source: StrategyDraftSource;
  sourceMessageId?: string;
  conversionWarnings?: string[];
  validationLabel?: "UNVERIFIED" | "EXPLORATION_ONLY" | "STANDARD_FAILED" | "STANDARD_VERIFIED";
  researchRunId?: string;
  researchCandidateId?: string;
}) {
  const db = getDb();
  const specification = normalizeResearchStrategyDsl(options.specification);
  const id = options.id || crypto.randomUUID();

  if (options.id) {
    const existing = (await db.select({
      authorUserId: communityStrategies.authorUserId,
      status: communityStrategies.status,
      version: communityStrategies.version,
    }).from(communityStrategies).where(and(
      eq(communityStrategies.id, id),
      eq(communityStrategies.authorUserId, options.userId),
    )).limit(1))[0];
    if (existing) return { id, status: existing.status, version: existing.version, created: false };
  }

  const name = options.name.trim();
  const summary = options.summary.trim();
  const symbols = [specification.symbol.replace(/USDT$/, "/USDT")];
  const specificationJson = JSON.stringify(specification);
  await db.batch([
    db.insert(communityStrategies).values({
      id,
      authorUserId: options.userId,
      name,
      summary,
      symbolsJson: JSON.stringify(symbols),
      riskLevel: options.riskLevel,
      publicationMode: options.publicationMode,
      validationLabel: options.validationLabel ?? "UNVERIFIED",
      researchRunId: options.researchRunId ?? null,
      researchCandidateId: options.researchCandidateId ?? null,
      conversationJson: "[]",
      specificationJson,
    }),
    db.insert(strategyVersions).values({
      id: crypto.randomUUID(),
      strategyId: id,
      version: 1,
      name,
      summary,
      specificationJson,
      conversationId: options.conversationId,
      source: options.source,
      createdByUserId: options.userId,
    }),
    db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: options.userId,
      action: options.sourceMessageId ? "ai.strategy_message.saved" : "strategy.draft.created",
      subjectType: "community_strategy",
      subjectId: id,
      afterJson: JSON.stringify({
        name,
        symbols,
        riskLevel: options.riskLevel,
        publicationMode: options.publicationMode,
        version: 1,
        source: options.source,
        sourceMessageId: options.sourceMessageId || null,
        conversionWarnings: options.conversionWarnings || [],
        schemaVersion: specification.schemaVersion,
      }),
    }),
  ]);
  return { id, status: "draft" as const, version: 1, created: true };
}
