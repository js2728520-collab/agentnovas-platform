import { ensureD1Schema } from "@/lib/d1-migrations";
import { getPostgresPool } from "@/lib/postgres";
import { getOwnedCandidateForSave, markCandidateSaved } from "@/lib/research-repository";
import { requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { createStrategyDraft } from "@/lib/strategy-drafts";
import { normalizeResearchStrategyDsl, strategyDslToRuntime } from "@/lib/strategy-dsl";

export async function POST(request: Request, { params }: {
  params: Promise<{ id: string; candidateId: string }>;
}) {
  try {
    await ensureD1Schema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id, candidateId } = await params;
    const pool = await getPostgresPool();
    const candidate = await getOwnedCandidateForSave(pool, {
      runId: id,
      candidateId,
      ownerUserId: user.id,
    });
    if (!candidate) throw new ResearchApiError("CANDIDATE_NOT_FOUND", "候选策略不存在", 404);
    const specification = normalizeResearchStrategyDsl(candidate.dsl);
    const runtime = strategyDslToRuntime(specification);
    const riskLevel = runtime.risk.maxDrawdownPct <= 8 ? "low" : runtime.risk.maxDrawdownPct <= 15 ? "medium" : "high";
    const strategyId = candidate.savedStrategyId || candidate.id;
    const saved = await createStrategyDraft({
      id: strategyId,
      userId: user.id,
      name: specification.name,
      summary: `${candidate.strategyFamily}；验证标签：${candidate.validationLabel}`,
      riskLevel,
      publicationMode: "self_use",
      specification,
      conversationId: candidate.conversationId,
      source: "ai_provider",
      validationLabel: candidate.validationLabel,
      researchRunId: id,
      researchCandidateId: candidate.id,
    });
    await markCandidateSaved(pool, { candidateId: candidate.id, strategyId: saved.id });
    return Response.json({
      strategyId: saved.id,
      version: saved.version,
      created: saved.created,
      validationLabel: candidate.validationLabel,
      simulationOnly: candidate.validationLabel !== "STANDARD_VERIFIED",
    }, { status: saved.created ? 201 : 200 });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
