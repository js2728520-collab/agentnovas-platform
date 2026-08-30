import type { AiRoleKey } from "@agentnovas/ai-control-plane";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient,"query">;

/** Compatibility names retained at the API boundary during the migration window. */
export type ClientAiModelRole = "report" | "proposal_a";

export type ResolvedLlmConfig = {
  providerName: string;
  model: string;
  source: "platform";
  role: ClientAiModelRole;
  roleKey: Extract<AiRoleKey,"client.assistant_message" | "client.strategy_generation">;
  profileId: string;
  revisionId: string;
  bindingPolicyRevisionId: string;
};

type RuntimeProjectionRow = {
  role: ClientAiModelRole;
  control_plane_role: "assistant_message" | "strategy_generation";
  profile_id: string;
  revision_id: string;
  provider_name: string;
  model_name: string;
  binding_policy_revision_id: string;
};

export async function resolveClientPlatformLlmConfig(
  database: Queryable,
  role: ClientAiModelRole,
): Promise<ResolvedLlmConfig | null> {
  const result = await database.query<RuntimeProjectionRow>(`
    SELECT role,control_plane_role,profile_id,revision_id,provider_name,model_name,binding_policy_revision_id
    FROM client_ai_control_plane_bindings_safe
    WHERE role=$1
    LIMIT 1
  `,[role]);
  const row = result.rows[0];
  const expectedControlPlaneRole = role === "report" ? "assistant_message" : "strategy_generation";
  if (!row || row.role !== role || row.control_plane_role !== expectedControlPlaneRole
    || !row.binding_policy_revision_id || !row.profile_id || !row.revision_id
    || !row.provider_name?.trim() || !row.model_name?.trim() || row.model_name.length > 200) return null;
  return {
    providerName: row.provider_name,
    model: row.model_name,
    source: "platform",
    role: row.role,
    roleKey: row.control_plane_role === "assistant_message"
      ? "client.assistant_message"
      : "client.strategy_generation",
    profileId: row.profile_id,
    revisionId: row.revision_id,
    bindingPolicyRevisionId: row.binding_policy_revision_id,
  };
}
