import { requireAccessPermission } from "@/lib/access-control";
import { rollbackControlPlaneDeployment } from "@/lib/ai-control-plane-repository";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { automaticAuditReason,maintenanceCorrelation } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson,ResearchApiError,researchErrorResponse } from "@/lib/research-api";

function resourceId(value: unknown,field: string) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) {
    throw new ResearchApiError("VALIDATION_ERROR",`${field} 无效`,422,{ fields: [field] });
  }
  return id;
}

/** Creates a new immutable revision by copying a historical source revision. */
export async function POST(request: Request,{ params }: {
  params: Promise<{ id: string }>;
}) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request,"maint.llm_profiles.manage");
    const { id } = await params;
    const body = await readResearchJson(request,4_096);
    const reason = automaticAuditReason("ai_control_plane.deployment.rollback");
    const result = await rollbackControlPlaneDeployment(await getPostgresPool(),{
      deploymentId: resourceId(id,"deploymentId"),
      sourceRevisionId: resourceId(body.sourceRevisionId,"sourceRevisionId"),
      expectedCurrentRevisionId: resourceId(body.expectedCurrentRevisionId,"expectedCurrentRevisionId"),
      actorUserId: user.id,reason,
      requestId: maintenanceCorrelation(request).requestId ?? crypto.randomUUID(),
    });
    return Response.json({ revision: result },{ status: result.replayed ? 200 : 201 });
  } catch (error) {
    return researchErrorResponse(error,request);
  }
}
