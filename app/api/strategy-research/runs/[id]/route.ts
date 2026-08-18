import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { getOwnedResearchRun, listResearchCandidates, listResearchEvaluations, listResearchEvents } from "@/lib/postgres-research-queue";
import { requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const pool = await getPostgresPool();
    const run = await getOwnedResearchRun(pool, { runId: id, ownerUserId: user.id });
    if (!run) throw new ResearchApiError("RUN_NOT_FOUND", "研发任务不存在", 404);
    const [events, candidates, evaluations] = await Promise.all([
      listResearchEvents(pool, { runId: id, ownerUserId: user.id }),
      listResearchCandidates(pool, { runId: id, ownerUserId: user.id }),
      listResearchEvaluations(pool, { runId: id, ownerUserId: user.id }),
    ]);
    return Response.json({ run, events, candidates, evaluations }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
