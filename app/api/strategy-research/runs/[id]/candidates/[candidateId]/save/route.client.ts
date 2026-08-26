import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import {
  getOwnedCandidateForSave,
  getOwnedStrategyDraftById,
  getSavedStrategyDraftForCandidate,
  markCandidateSaved,
  withResearchCandidateSaveLock,
} from "@/lib/research-repository";
import {
  readResearchJson,
  requireResearchUser,
  ResearchApiError,
  researchErrorResponse,
} from "@/lib/research-api";
import { createStrategyDraft } from "@/lib/strategy-drafts";
import {
  prepareEditableStrategyCandidate,
  strategyCandidateSpecificationsEqual,
} from "@/packages/domain/src/editable-strategy-candidate";
import { StrategyDslValidationError, strategyDslToRuntime } from "@/packages/domain/src/strategy-dsl";

export async function POST(request: Request, { params }: {
  params: Promise<{ id: string; candidateId: string }>;
}) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id, candidateId } = await params;
    let requestedSpecification: unknown;
    if (request.body) {
      const body = await readResearchJson(request);
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== "specification") {
        throw new ResearchApiError("VALIDATION_ERROR", "请求只允许 specification 字段", 400);
      }
      requestedSpecification = body.specification;
    }
    const pool = await getPostgresPool();
    return await withResearchCandidateSaveLock(pool, candidateId, async database => {
      const candidate = await getOwnedCandidateForSave(database, {
        runId: id,
        candidateId,
        ownerUserId: user.id,
      });
      if (!candidate) throw new ResearchApiError("CANDIDATE_NOT_FOUND", "候选策略不存在", 404);
      let prepared;
      try {
        prepared = prepareEditableStrategyCandidate({
          candidateSpecification: candidate.dsl,
          requestedSpecification,
          candidateValidationLabel: candidate.validationLabel,
        });
      } catch (error) {
        if (error instanceof StrategyDslValidationError) {
          throw new ResearchApiError("DSL_VALIDATION_FAILED", "编辑后的策略未通过 DSL 校验", 422, {
            issues: error.issues,
          });
        }
        throw error;
      }
      if (candidate.savedStrategyId) {
        const existing = await getSavedStrategyDraftForCandidate(database, { candidateId: candidate.id });
        if (!existing) {
          throw new ResearchApiError("SAVED_STRATEGY_INCONSISTENT", "已保存策略版本不完整", 500);
        }
        if (!strategyCandidateSpecificationsEqual(existing.specification, prepared.specification)) {
          throw new ResearchApiError(
            "CANDIDATE_ALREADY_SAVED",
            "候选已保存为不可变版本，不能用另一份参数覆盖",
            409,
          );
        }
        const edited = !strategyCandidateSpecificationsEqual(candidate.dsl, existing.specification);
        return Response.json({
          strategyId: existing.strategyId,
          version: existing.version,
          versionId: existing.strategyVersionId,
          created: false,
          edited,
          specification: existing.specification,
          validationLabel: existing.validationLabel,
          simulationOnly: existing.validationLabel !== "STANDARD_VERIFIED",
        });
      }
      const recoverable = await getOwnedStrategyDraftById(database, {
        strategyId: candidate.id,
        ownerUserId: user.id,
      });
      if (recoverable) {
        if (
          recoverable.validationLabel !== prepared.validationLabel
          || !strategyCandidateSpecificationsEqual(recoverable.specification, prepared.specification)
        ) {
          throw new ResearchApiError(
            "CANDIDATE_ALREADY_SAVED",
            "候选已有不可变草稿，不能用另一份参数或验证标签覆盖",
            409,
          );
        }
        await markCandidateSaved(database, {
          candidateId: candidate.id,
          strategyId: recoverable.strategyId,
          strategyVersionId: recoverable.strategyVersionId,
        });
        return Response.json({
          strategyId: recoverable.strategyId,
          version: recoverable.version,
          versionId: recoverable.strategyVersionId,
          created: false,
          edited: prepared.edited,
          specification: recoverable.specification,
          validationLabel: recoverable.validationLabel,
          simulationOnly: recoverable.validationLabel !== "STANDARD_VERIFIED",
        });
      }
      const runtime = strategyDslToRuntime(prepared.specification);
      const riskLevel = runtime.risk.maxDrawdownPct <= 8 ? "low" : runtime.risk.maxDrawdownPct <= 15 ? "medium" : "high";
      const saved = await createStrategyDraft({
        id: candidate.id,
        userId: user.id,
        name: prepared.specification.name,
        summary: prepared.edited
          ? `${candidate.strategyFamily}；用户编辑后需重新回测`
          : `${candidate.strategyFamily}；验证标签：${candidate.validationLabel}`,
        riskLevel,
        publicationMode: "self_use",
        specification: prepared.specification,
        conversationId: candidate.conversationId,
        source: prepared.edited ? "manual" : "ai_provider",
        validationLabel: prepared.validationLabel,
        researchRunId: id,
        researchCandidateId: candidate.id,
      });
      await markCandidateSaved(database, {
        candidateId: candidate.id,
        strategyId: saved.id,
        strategyVersionId: saved.versionId,
      });
      return Response.json({
        strategyId: saved.id,
        version: saved.version,
        versionId: saved.versionId,
        created: saved.created,
        edited: prepared.edited,
        specification: prepared.specification,
        validationLabel: prepared.validationLabel,
        simulationOnly: prepared.validationLabel !== "STANDARD_VERIFIED",
      }, { status: saved.created ? 201 : 200 });
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
