import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { getOwnedResearchRun, resumeResearchRunWithAnswers } from "@/lib/postgres-research-queue";
import { readResearchJson, requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const body = await readResearchJson(request, 16_384);
    if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) {
      throw new ResearchApiError("VALIDATION_ERROR", "answers 必须是对象", 422);
    }
    const pool = await getPostgresPool();
    const run = await getOwnedResearchRun(pool, { runId: id, ownerUserId: user.id });
    if (!run) throw new ResearchApiError("RUN_NOT_FOUND", "研发任务不存在", 404);
    if (run.status !== "awaiting_user_input") {
      throw new ResearchApiError("INPUT_NOT_REQUIRED", "当前任务不需要补充输入", 409);
    }
    const requirements = run.result?.requirements as Record<string, unknown> | undefined;
    const missingFields = Array.isArray(requirements?.missingFields) ? requirements.missingFields : [];
    const allowed = new Set(missingFields.map(item => item && typeof item === "object" ? String((item as Record<string, unknown>).key ?? "") : ""));
    const entries = Object.entries(body.answers as Record<string, unknown>);
    if (!entries.length || entries.length > 8) throw new ResearchApiError("VALIDATION_ERROR", "请至少补充一个有效条件", 422);
    const answers: Record<string, string | number | boolean> = {};
    for (const [key, value] of entries) {
      if (!allowed.has(key)) throw new ResearchApiError("UNEXPECTED_ANSWER", `不需要补充字段：${key}`, 422);
      if (typeof value === "string") {
        if (!value.trim() || value.length > 500) throw new ResearchApiError("VALIDATION_ERROR", `字段 ${key} 无效`, 422);
        answers[key] = value.trim();
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new ResearchApiError("VALIDATION_ERROR", `字段 ${key} 无效`, 422);
        answers[key] = value;
      } else if (typeof value === "boolean") answers[key] = value;
      else throw new ResearchApiError("VALIDATION_ERROR", `字段 ${key} 类型无效`, 422);
    }
    const resumed = await resumeResearchRunWithAnswers(pool, { runId: id, ownerUserId: user.id, answers });
    return Response.json({ runId: resumed.id, status: resumed.status }, { status: 202 });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
