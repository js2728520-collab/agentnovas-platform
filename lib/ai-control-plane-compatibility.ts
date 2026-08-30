import type { AiRoleKey } from "@agentnovas/ai-control-plane";
import type { Pool,PoolClient,QueryResultRow } from "pg";

import {
  createProbeRequest,
  rollbackControlPlaneDeployment,
  saveConnectionDeployment,
  updateBindingPolicy,
} from "./ai-control-plane-repository.ts";
import { requestAiGatewayProbe } from "./ai-gateway-client.ts";
import { normalizeLlmBaseUrl } from "./llm-endpoint.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient,"query">;

export const agentRoles = [
  "requirements","market_regime","proposal_a","proposal_b","adversarial_review","risk_review","report",
] as const;
export type AgentRole = typeof agentRoles[number];
export const runtimeExplanationRoles = ["market_summary","adversarial_explanation","risk_explanation"] as const;
export type RuntimeExplanationRole = typeof runtimeExplanationRoles[number];

export type CompatibilityLlmProfileInput = {
  name?: unknown;
  providerName?: unknown;
  baseUrl?: unknown;
  modelName?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
};

const roleKeys = {
  requirements: "research.requirements",market_regime: "research.market_regime",
  proposal_a: "research.proposal_a",proposal_b: "research.proposal_b",
  adversarial_review: "research.adversarial_review",risk_review: "research.risk_review",report: "research.report",
  market_summary: "runtime.market_summary",adversarial_explanation: "runtime.adversarial_explanation",
  risk_explanation: "runtime.risk_explanation",assistant_message: "client.assistant_message",
  strategy_generation: "client.strategy_generation",
} as const satisfies Record<string,AiRoleKey>;

type SnapshotRow = QueryResultRow & {
  role: keyof typeof roleKeys;
  runtime_state: "active" | "gated" | "disabled" | "retired";
  binding_policy_id: string;
  binding_policy_revision_id: string | null;
  target_rank: number | null;
  deployment_id: string | null;
  deployment_name: string | null;
  deployment_revision_id: string | null;
  deployment_revision_number: number | null;
  model_id: string | null;
  connection_id: string | null;
  connection_name: string | null;
  latest_probe_status: string | null;
  probe_matches_configuration: boolean | null;
  binding_updated_at: Date;
};

async function snapshotRows(database: Queryable) {
  return (await database.query<SnapshotRow>(`
    SELECT role,runtime_state,binding_policy_id,binding_policy_revision_id,target_rank,
      deployment_id,deployment_name,deployment_revision_id,deployment_revision_number,model_id,
      connection_id,connection_name,latest_probe_status,probe_matches_configuration,binding_updated_at
    FROM maintenance_ai_control_plane_snapshot_safe ORDER BY role,target_rank
  `)).rows;
}

function configured(row: SnapshotRow | undefined) {
  return Boolean(row?.deployment_revision_id && row.runtime_state !== "disabled"
    && row.latest_probe_status === "succeeded" && row.probe_matches_configuration);
}

export async function listLlmProfiles(database: Queryable) {
  const result = await database.query<{
    id: string;name: string;model_id: string | null;enabled: boolean;
    current_revision_id: string | null;connection_name: string | null;has_secret: boolean;
    created_at: Date;updated_at: Date;
  }>(`
    SELECT deployment.id,deployment.name,deployment.model_id,deployment.enabled,
      deployment.current_revision_id,connection.name AS connection_name,
      COALESCE(connection.has_secret,false) AS has_secret,deployment.created_at,deployment.updated_at
    FROM maintenance_ai_deployments_safe AS deployment
    LEFT JOIN maintenance_ai_connections_safe AS connection ON connection.id=deployment.connection_id
    ORDER BY deployment.name,deployment.id
  `);
  return result.rows.map((row) => ({
    id: row.id,name: row.name,providerName: row.connection_name ?? "OpenAI-compatible",
    modelName: row.model_id ?? "",baseUrl: "",maskedApiKey: "",hasApiKey: row.has_secret,
    enabled: row.enabled,currentRevisionId: row.current_revision_id,
    createdAt: row.created_at,updatedAt: row.updated_at,
  }));
}

export async function listLlmProfileRevisions(database: Queryable, deploymentId: string) {
  const result = await database.query<{
    id: string;revision_number: number;deployment_name: string;model_id: string;
    connection_name: string;created_at: Date;is_current: boolean;has_secret: boolean;
  }>(`
    SELECT revision.id,revision.revision_number,revision.deployment_name,revision.model_id,
      revision.connection_name,revision.created_at,revision.is_current,revision.has_secret
    FROM maintenance_ai_deployment_revisions_safe AS revision
    WHERE revision.deployment_id=$1 ORDER BY revision.revision_number DESC LIMIT 100
  `,[deploymentId]);
  return result.rows.map((row) => ({
    id: row.id,revisionNumber: row.revision_number,name: row.deployment_name,
    providerName: row.connection_name,modelName: row.model_id,hasSecret: row.has_secret,
    enabled: row.is_current,isCurrent: row.is_current,createdByUserId: "control-plane",createdAt: row.created_at.toISOString(),
  }));
}

function requiredText(value: unknown,field: string,maximum: number) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new ResearchApiError("VALIDATION_ERROR",`${field} 无效`,422,{ fields: [field] });
  }
  return normalized;
}

/**
 * Web-safe legacy write facade. Plaintext secrets are deliberately rejected;
 * callers must use the browser envelope + Secret Broker route after creating
 * the connection/deployment revision.
 */
export async function saveCompatibilityLlmProfile(database: Queryable,input: {
  id?: string;actorUserId: string;profile: CompatibilityLlmProfileInput;reason: string;requestId: string;
}) {
  if (String(input.profile.apiKey ?? "").trim()) {
    throw new ResearchApiError(
      "MODEL_KEY_ENVELOPE_REQUIRED",
      "旧接口不再接收明文 API Key，请使用 AI 控制面的浏览器加密与 Secret Broker 流程",
      422,
    );
  }
  const deploymentId = input.id ?? crypto.randomUUID();
  const existing = input.id ? (await database.query<{
    connection_id: string | null;name: string;model_id: string | null;
  }>("SELECT connection_id,name,model_id FROM maintenance_ai_deployments_safe WHERE id=$1",[deploymentId])).rows[0] : null;
  if (input.id && !existing) throw new ResearchApiError("MODEL_PROFILE_NOT_FOUND","模型部署不存在",404);
  const connectionId = existing?.connection_id ?? crypto.randomUUID();
  const name = requiredText(input.profile.name ?? existing?.name,"配置名称",120);
  const providerName = requiredText(input.profile.providerName,"供应商名称",120);
  const modelName = requiredText(input.profile.modelName ?? existing?.model_id,"模型名称",200);
  const endpoint = normalizeLlmBaseUrl(input.profile.baseUrl);
  const result = await saveConnectionDeployment(database,{
    connectionId,connectionRevisionId: crypto.randomUUID(),connectionName: providerName,endpoint,
    deploymentId,deploymentRevisionId: crypto.randomUUID(),deploymentName: name,modelId: modelName,
    contextWindow: null,maxOutputTokens: null,supportsStreaming: true,supportsStructuredOutput: false,
    rateCardRevisionId: null,rateCard: null,
    actorUserId: input.actorUserId,reason: input.reason,requestId: input.requestId,
  });
  return {
    id: deploymentId,name,providerName,modelName,baseUrl: "",maskedApiKey: "",hasApiKey: false,
    enabled: false,currentRevisionId: result.deploymentRevisionId,createdAt: new Date(),updatedAt: new Date(),
  };
}

export async function rollbackCompatibilityLlmProfileRevision(database: Queryable,input: {
  profileId: string;revisionId: string;expectedCurrentRevisionId: string;
  actorUserId: string;reason: string;requestId: string;
}) {
  return rollbackControlPlaneDeployment(database,{
    deploymentId: input.profileId,sourceRevisionId: input.revisionId,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,actorUserId: input.actorUserId,
    reason: input.reason,requestId: input.requestId,
  });
}

async function bindingViews<Role extends string>(database: Queryable,roles: readonly Role[],_visibility: "administrator" | "customer") {
  if (_visibility !== "administrator" && _visibility !== "customer") throw new Error("AI_BINDING_VISIBILITY_INVALID");
  const rows = await snapshotRows(database);
  return roles.map((role) => {
    const row = rows.find((candidate) => candidate.role === role && candidate.target_rank === 0);
    const base = { role,modelName: row?.model_id ?? "",enabled: row?.runtime_state !== "disabled",configured: configured(row) };
    return {
      ...base,id: row?.binding_policy_id ?? `binding:${role}`,profileId: row?.deployment_id ?? "",
      revisionId: row?.deployment_revision_id ?? "",revisionNumber: row?.deployment_revision_number ?? 0,
      profileName: row?.deployment_name ?? "",providerName: row?.connection_name ?? "",baseUrl: "",
      maskedApiKey: "",profileEnabled: configured(row),updatedAt: row?.binding_updated_at ?? new Date(0),
    };
  });
}

export function listAgentRoleBindings(database: Queryable,options: { visibility: "administrator" | "customer" }) {
  return bindingViews(database,agentRoles,options.visibility);
}

export function listRuntimeExplanationBindings(database: Queryable,options: { visibility: "administrator" | "customer" }) {
  return bindingViews(database,runtimeExplanationRoles,options.visibility);
}

export async function missingAgentRoles(database: Queryable) {
  const rows = await snapshotRows(database);
  return agentRoles.filter((role) => !configured(rows.find((row) => row.role === role && row.target_rank === 0)));
}

export async function snapshotAgentRoleBindings(database: Queryable) {
  const rows = await snapshotRows(database);
  const roles = Object.fromEntries(agentRoles.flatMap((role) => {
    const row = rows.find((candidate) => candidate.role === role && candidate.target_rank === 0);
    return configured(row) ? [[role,{
      profileId: row!.deployment_id!,revisionId: row!.deployment_revision_id!,
      revisionNumber: row!.deployment_revision_number ?? 0,modelName: row!.model_id ?? "",
    }]] : [];
  }));
  return { roles,missingRoles: agentRoles.filter((role) => !(role in roles)) };
}

async function bindCompatibilityRole(database: Queryable,input: {
  actorUserId: string;role: keyof typeof roleKeys;profileId: string;enabled?: boolean;
  reason?: string;requestId?: string;
}) {
  const deployment = (await database.query<{ current_revision_id: string | null }>(
    "SELECT current_revision_id FROM maintenance_ai_deployments_safe WHERE id=$1",[input.profileId],
  )).rows[0];
  if (!deployment?.current_revision_id) throw new ResearchApiError("MODEL_PROFILE_NOT_FOUND","模型部署不存在",404);
  const result = await updateBindingPolicy(database,{
    roleKey: roleKeys[input.role],revisionId: crypto.randomUUID(),
    deploymentRevisionIds: [deployment.current_revision_id],enabled: input.enabled !== false,
    actorUserId: input.actorUserId,reason: input.reason ?? "Legacy API compatibility binding",
    requestId: input.requestId ?? crypto.randomUUID(),
  });
  return { id: result.revisionId,role: input.role,profileId: input.profileId,enabled: input.enabled !== false,updatedAt: new Date() };
}

type CompatibilityBindingInput = {
  actorUserId: string;role: string;profileId: string;enabled?: boolean;reason?: string;requestId?: string;
};

export function bindAgentRole(database: Queryable,input: CompatibilityBindingInput) {
  if (!agentRoles.includes(input.role as AgentRole)) throw new ResearchApiError("AI_ROLE_INVALID","Research 角色无效",422);
  return bindCompatibilityRole(database,{ ...input,role: input.role as AgentRole });
}

export function bindRuntimeExplanationRole(database: Queryable,input: CompatibilityBindingInput) {
  if (!runtimeExplanationRoles.includes(input.role as RuntimeExplanationRole)) throw new ResearchApiError("AI_ROLE_INVALID","Runtime 角色无效",422);
  return bindCompatibilityRole(database,{ ...input,role: input.role as RuntimeExplanationRole });
}

export async function probeCompatibilityRole(database: Queryable,input: {
  role: string;actorUserId: string;reason: string;requestId: string;signal?: AbortSignal;
}) {
  if (!(input.role in roleKeys)) throw new ResearchApiError("AI_ROLE_INVALID","AI 角色无效",422);
  const role = input.role as keyof typeof roleKeys;
  const row = (await snapshotRows(database)).find((candidate) => candidate.role === role && candidate.target_rank === 0);
  if (!row?.deployment_revision_id) throw new ResearchApiError("AI_BINDING_MISSING","该角色尚未绑定模型",409);
  const requested = await createProbeRequest(database,{
    id: crypto.randomUUID(),deploymentRevisionId: row.deployment_revision_id,
    actorUserId: input.actorUserId,reason: input.reason,requestId: input.requestId,
  });
  return requestAiGatewayProbe({
    probeReceiptId: requested.probeReceiptId,deploymentRevisionId: row.deployment_revision_id,
    requestedByUserId: input.actorUserId,signal: input.signal,
  });
}
