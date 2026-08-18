import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { requireResearchUser, researchErrorResponse } from "@/lib/research-api";
import { changeStrategyDeploymentStatus } from "@/lib/strategy-runtime-repository";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabaseSchema();
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const deployment = await changeStrategyDeploymentStatus(await getPostgresPool(), {
      deploymentId: id,
      ownerUserId: user.id,
      action: "resume",
    });
    return Response.json({ deployment });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
