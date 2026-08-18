import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { requestResearchRunCancellation } from "@/lib/postgres-research-queue";
import { requireResearchUser, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const pool = await getPostgresPool();
    const run = await requestResearchRunCancellation(pool, {
      runId: id,
      ownerUserId: user.id,
      now: new Date(),
    });
    return Response.json({ runId: run.id, status: run.status, cancelRequestedAt: run.cancelRequestedAt });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
