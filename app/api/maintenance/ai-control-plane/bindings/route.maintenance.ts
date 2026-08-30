import type { AiRoleKey } from "@agentnovas/ai-control-plane";

import { requireAccessPermission } from "@/lib/access-control";
import { updateBindingPolicy } from "@/lib/ai-control-plane-repository";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { automaticAuditReason,maintenanceCorrelation } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson,ResearchApiError,researchErrorResponse } from "@/lib/research-api";

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request,"maint.agent_bindings.manage");
    const body = await readResearchJson(request);
    const reason = automaticAuditReason("ai_control_plane.binding.update");
    const roleKey = String(body.roleKey ?? "") as AiRoleKey;
    const deploymentRevisionIds = Array.isArray(body.deploymentRevisionIds)
      ? body.deploymentRevisionIds.map(String)
      : [];
    if (deploymentRevisionIds.length < 1 || deploymentRevisionIds.length > 3
      || deploymentRevisionIds.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))) {
      throw new ResearchApiError("VALIDATION_ERROR","主模型与回退链无效",422,{ fields: ["deploymentRevisionIds"] });
    }
    const correlation = maintenanceCorrelation(request);
    const result = await updateBindingPolicy(await getPostgresPool(),{
      roleKey,revisionId: crypto.randomUUID(),deploymentRevisionIds,enabled: body.enabled !== false,
      actorUserId: user.id,reason,requestId: correlation.requestId ?? crypto.randomUUID(),
    });
    return Response.json(result);
  } catch (error) {
    return researchErrorResponse(error,request);
  }
}
