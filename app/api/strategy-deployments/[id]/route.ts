import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";
import { getOwnedStrategyDeployment } from "@/lib/strategy-runtime-repository";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const deployment = await getOwnedStrategyDeployment(await getPostgresPool(), {
      deploymentId: id,
      ownerUserId: user.id,
    });
    if (!deployment) throw new ResearchApiError("DEPLOYMENT_NOT_FOUND", "策略部署不存在", 404);
    return Response.json({ deployment }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
