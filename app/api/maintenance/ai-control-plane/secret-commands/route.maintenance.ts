import type { SecretEnvelopeCommand } from "@agentnovas/ai-control-plane";

import { requireAccessPermission } from "@/lib/access-control";
import { enqueueSecretCommand } from "@/lib/ai-control-plane-repository";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { maintenanceCorrelation,maintenanceReason } from "@/lib/maintenance-audit";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson,ResearchApiError,researchErrorResponse } from "@/lib/research-api";

function envelopeFrom(body: Record<string,unknown>): SecretEnvelopeCommand {
  const source = body.envelope;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new ResearchApiError("VALIDATION_ERROR","密钥信封无效",422,{ fields: ["envelope"] });
  }
  const value = source as Record<string,unknown>;
  return {
    commandId: String(value.commandId ?? ""),
    targetConnectionRevisionId: String(value.targetConnectionRevisionId ?? ""),
    brokerKeyId: String(value.brokerKeyId ?? ""),
    algorithm: String(value.algorithm ?? "") as SecretEnvelopeCommand["algorithm"],
    wrappedDataKey: String(value.wrappedDataKey ?? ""),iv: String(value.iv ?? ""),
    ciphertext: String(value.ciphertext ?? ""),authTag: String(value.authTag ?? ""),
    envelopeDigestSha256: String(value.envelopeDigestSha256 ?? ""),
  };
}

export async function POST(request: Request) {
  try {
    await ensureDatabaseSchema();
    const { user } = await requireAccessPermission(request,"maint.llm_profiles.manage");
    const body = await readResearchJson(request,64_000);
    const reason = maintenanceReason(body.reason);
    const envelope = envelopeFrom(body);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(envelope.commandId)) {
      throw new ResearchApiError("VALIDATION_ERROR","密钥命令 ID 无效",422,{ fields: ["commandId"] });
    }
    const correlation = maintenanceCorrelation(request);
    const result = await enqueueSecretCommand(await getPostgresPool(),{
      envelope,actorUserId: user.id,idempotencyKey: envelope.commandId,reason,
      requestId: correlation.requestId ?? crypto.randomUUID(),
    });
    return Response.json(result,{ status: 202 });
  } catch (error) {
    return researchErrorResponse(error,request);
  }
}
