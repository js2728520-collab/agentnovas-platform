import type { BudgetPolicy } from "@agentnovas/ai-control-plane";

import { requireAccessPermission } from "@/lib/access-control";
import { upsertBudgetPolicy } from "@/lib/ai-control-plane-repository";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { maintenanceCorrelation,maintenanceReason } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson,ResearchApiError,researchErrorResponse } from "@/lib/research-api";

export async function PUT(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request,"maint.llm_profiles.manage");
    const body = await readResearchJson(request);
    const reason = maintenanceReason(body.reason);
    const scope = String(body.scope ?? "") as BudgetPolicy["scope"];
    const scopeId = String(body.scopeId ?? "").trim();
    const period = String(body.period ?? "") as "day" | "month";
    const unit = String(body.unit ?? "") as BudgetPolicy["unit"];
    const limit = String(body.limit ?? "").trim();
    if (!new Set(["platform","organization","consumer","role","deployment"]).has(scope)
      || !scopeId || scopeId.length > 200 || !new Set(["day","month"]).has(period)
      || !new Set(["requests","tokens","provider_cost","platform_credits"]).has(unit)
      || !/^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$/.test(limit) || Number(limit) <= 0) {
      throw new ResearchApiError("VALIDATION_ERROR","预算策略无效",422);
    }
    const correlation = maintenanceCorrelation(request);
    const result = await upsertBudgetPolicy(await getPostgresPool(),{
      id: body.id ? String(body.id) : crypto.randomUUID(),scope,scopeId,period,limit,unit,
      enabled: body.enabled !== false,actorUserId: user.id,reason,
      requestId: correlation.requestId ?? crypto.randomUUID(),
    });
    return Response.json(result);
  } catch (error) {
    return researchErrorResponse(error,request);
  }
}
