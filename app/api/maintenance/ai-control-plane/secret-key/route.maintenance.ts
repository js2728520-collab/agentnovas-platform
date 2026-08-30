import { requireAccessPermission } from "@/lib/access-control";
import { readActiveSecretBrokerKey } from "@/lib/ai-control-plane-repository";
import { ensureDatabaseSchema } from "@/lib/database-schema";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError,researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    await ensureDatabaseSchema();
    await requireAccessPermission(request,"maint.llm_profiles.manage");
    const row = await readActiveSecretBrokerKey(await getPostgresPool());
    if (!row) throw new ResearchApiError("AI_SECRET_BROKER_KEY_UNAVAILABLE","Secret Broker 公钥未就绪",503);
    return Response.json({ key: {
      keyId: row.key_id,algorithm: row.algorithm,publicKeySpkiBase64: row.public_key_spki_base64,
      fingerprintSha256: row.fingerprint_sha256,notBefore: row.not_before.toISOString(),
      notAfter: row.not_after?.toISOString() ?? null,
    } },{ headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error,request);
  }
}
