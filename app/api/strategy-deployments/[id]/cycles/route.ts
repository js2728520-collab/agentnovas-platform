import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { listOwnedRuntimeCycles } from "@/lib/strategy-runtime-repository";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const after = Number(new URL(request.url).searchParams.get("afterSequence") || 0);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new ResearchApiError("VALIDATION_ERROR", "afterSequence 必须是非负整数", 422);
    }
    const cycles = await listOwnedRuntimeCycles(await getPostgresPool(), {
      deploymentId: id,
      ownerUserId: user.id,
      afterSequence: after,
    });
    return Response.json({ cycles }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
