import { requireAccessPermission } from "@/lib/access-control";
import { saveConnectionDeployment } from "@/lib/ai-control-plane-repository";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { normalizeLlmBaseUrl } from "@/lib/llm-endpoint";
import { automaticAuditReason,maintenanceCorrelation } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson,ResearchApiError,researchErrorResponse } from "@/lib/research-api";

function text(value: unknown,field: string,maximum: number) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new ResearchApiError("VALIDATION_ERROR",`${field} 无效`,422,{ fields: [field] });
  }
  return normalized;
}

function optionalPositiveInteger(value: unknown,field: string) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ResearchApiError("VALIDATION_ERROR",`${field} 必须是正整数`,422,{ fields: [field] });
  }
  return number;
}

function optionalRateCard(body: Record<string,unknown>) {
  const currency = String(body.rateCurrency ?? "").trim().toUpperCase();
  const inputPerMillion = String(body.inputCostPerMillion ?? "").trim();
  const outputPerMillion = String(body.outputCostPerMillion ?? "").trim();
  const cachedInputPerMillion = String(body.cachedInputCostPerMillion ?? "").trim();
  if (!currency && !inputPerMillion && !outputPerMillion && !cachedInputPerMillion) return null;
  const exactAmount = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$/;
  if (!/^[A-Z]{3,8}$/.test(currency) || !exactAmount.test(inputPerMillion)
    || !exactAmount.test(outputPerMillion) || cachedInputPerMillion && !exactAmount.test(cachedInputPerMillion)) {
    throw new ResearchApiError("VALIDATION_ERROR","Rate Card 必须包含币种及精确的百万 Token 输入/输出价格",422,{
      fields: ["rateCurrency","inputCostPerMillion","outputCostPerMillion","cachedInputCostPerMillion"],
    });
  }
  return { currency,inputPerMillion,outputPerMillion,cachedInputPerMillion: cachedInputPerMillion || null };
}

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request,"maint.llm_profiles.manage");
    const body = await readResearchJson(request,32_768);
    const reason = automaticAuditReason("ai_control_plane.configuration.save");
    const correlation = maintenanceCorrelation(request);
    const rateCard = optionalRateCard(body);
    const result = await saveConnectionDeployment(await getPostgresPool(),{
      connectionId: body.connectionId ? text(body.connectionId,"connectionId",160) : crypto.randomUUID(),
      connectionRevisionId: crypto.randomUUID(),
      connectionName: text(body.connectionName,"connectionName",120),
      endpoint: normalizeLlmBaseUrl(body.baseUrl),
      deploymentId: body.deploymentId ? text(body.deploymentId,"deploymentId",160) : crypto.randomUUID(),
      deploymentRevisionId: crypto.randomUUID(),
      deploymentName: text(body.deploymentName,"deploymentName",120),
      modelId: text(body.modelId,"modelId",200),
      contextWindow: optionalPositiveInteger(body.contextWindow,"contextWindow"),
      maxOutputTokens: optionalPositiveInteger(body.maxOutputTokens,"maxOutputTokens"),
      supportsStreaming: body.supportsStreaming !== false,
      supportsStructuredOutput: body.supportsStructuredOutput === true,
      rateCardRevisionId: rateCard ? crypto.randomUUID() : null,rateCard,
      actorUserId: user.id,reason,requestId: correlation.requestId ?? crypto.randomUUID(),
    });
    return Response.json({ configuration: result },{ status: 201 });
  } catch (error) {
    return researchErrorResponse(error,request);
  }
}
