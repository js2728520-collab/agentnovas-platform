import type { Pool, PoolClient } from "pg";

import { decryptLlmProfileSecret } from "./integration-credentials.ts";
import { normalizeLlmCompletionEndpoint } from "./llm-endpoint.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type ClientAiModelRole = "report" | "proposal_a";

export type ResolvedLlmConfig = {
  providerName: string;
  endpoint: string;
  apiStyle: "chat_completions" | "responses";
  model: string;
  apiKey: string;
  source: "platform";
  role: ClientAiModelRole;
  profileId: string;
  revisionId: string;
};

type RuntimeProjectionRow = {
  role: ClientAiModelRole;
  profile_id: string;
  revision_id: string;
  provider_name: string;
  base_url: string;
  model_name: string;
  encrypted_api_key: string;
};

export async function resolveClientPlatformLlmConfig(
  database: Queryable,
  role: ClientAiModelRole,
): Promise<ResolvedLlmConfig | null> {
  const result = await database.query<RuntimeProjectionRow>(`
    SELECT role,profile_id,revision_id,provider_name,base_url,model_name,encrypted_api_key
      FROM client_ai_runtime_model_bindings
     WHERE role=$1
     LIMIT 1
  `, [role]);
  const row = result.rows[0];
  if (!row) return null;
  try {
    const target = normalizeLlmCompletionEndpoint(row.base_url);
    const apiKey = await decryptLlmProfileSecret(row.encrypted_api_key);
    if (!apiKey.trim() || apiKey.length > 4_096 || !row.model_name.trim() || row.model_name.length > 100) return null;
    return {
      providerName: row.provider_name,
      endpoint: target.endpoint,
      apiStyle: target.apiStyle,
      model: row.model_name,
      apiKey,
      source: "platform",
      role: row.role,
      profileId: row.profile_id,
      revisionId: row.revision_id,
    };
  } catch {
    return null;
  }
}
