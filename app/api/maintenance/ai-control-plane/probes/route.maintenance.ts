import { requireAccessPermission } from "@/lib/access-control";
import { createProbeRequest } from "@/lib/ai-control-plane-repository";
import { requestAiGatewayProbe } from "@/lib/ai-gateway-client";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { automaticAuditReason,maintenanceCorrelation } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson,ResearchApiError,researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request,"maint.llm_profiles.manage");
    const body = await readResearchJson(request);
    const reason = automaticAuditReason("ai_control_plane.probe.request");
    const deploymentRevisionId = String(body.deploymentRevisionId ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(deploymentRevisionId)) {
      throw new ResearchApiError("VALIDATION_ERROR","模型修订无效",422,{ fields: ["deploymentRevisionId"] });
    }
    const correlation = maintenanceCorrelation(request);
    const requested = await createProbeRequest(await getPostgresPool(),{
      id: crypto.randomUUID(),deploymentRevisionId,actorUserId: user.id,reason,
      requestId: correlation.requestId ?? crypto.randomUUID(),
    });
    const result = await requestAiGatewayProbe({
      probeReceiptId: requested.probeReceiptId,deploymentRevisionId,requestedByUserId: user.id,
      signal: request.signal,
    });
    return Response.json(result);
  } catch (error) {
    return researchErrorResponse(error,request);
  }
}
