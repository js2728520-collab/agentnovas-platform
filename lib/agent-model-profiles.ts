import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  maskedIntegrationSecret,
} from "./integration-credentials.ts";
import { normalizeLlmBaseUrl, normalizeLlmCompletionEndpoint } from "./llm-endpoint.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export const agentRoles = [
  "requirements",
  "market_regime",
  "proposal_a",
  "proposal_b",
  "adversarial_review",
  "risk_review",
  "report",
] as const;

export type AgentRole = typeof agentRoles[number];

export type LlmProfileInput = {
  name?: unknown;
  providerName?: unknown;
  baseUrl?: unknown;
  modelName?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
};

type ProfileRow = QueryResultRow & {
  id: string;
  name: string;
  provider_name: string;
  base_url: string;
  model_name: string;
  encrypted_api_key: string;
  masked_api_key: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

type BindingRow = QueryResultRow & {
  id: string;
  role: AgentRole;
  llm_profile_id: string;
  enabled: boolean;
  model_name: string;
  profile_name: string;
  provider_name: string;
  base_url: string;
  encrypted_api_key: string;
  masked_api_key: string;
  profile_enabled: boolean;
  updated_at: Date;
};

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`请填写${label}`);
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function assertAgentRole(role: string): asserts role is AgentRole {
  if (!agentRoles.includes(role as AgentRole)) throw new Error("不支持的 Agent 角色");
}

function profileFromRow(row: ProfileRow) {
  return {
    id: row.id,
    name: row.name,
    providerName: row.provider_name,
    baseUrl: row.base_url,
    modelName: row.model_name,
    maskedApiKey: row.masked_api_key,
    hasApiKey: Boolean(row.encrypted_api_key),
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listLlmProfiles(database: Queryable) {
  const result = await database.query<ProfileRow>(`
    SELECT id, name, provider_name, base_url, model_name, encrypted_api_key,
           masked_api_key, enabled, created_at, updated_at
    FROM llm_profiles
    ORDER BY name, id
  `);
  return result.rows.map(profileFromRow);
}

export async function saveLlmProfile(database: Queryable, options: {
  actorUserId: string;
  id?: string;
  input: LlmProfileInput;
}) {
  const id = options.id ?? crypto.randomUUID();
  const existing = options.id
    ? (await database.query<ProfileRow>("SELECT * FROM llm_profiles WHERE id = $1", [id])).rows[0]
    : undefined;
  if (options.id && !existing) throw new Error("模型 Profile 不存在");

  const name = requiredText(options.input.name, "配置名称", 80);
  const providerName = requiredText(options.input.providerName, "供应商名称", 60);
  const baseUrl = normalizeLlmBaseUrl(options.input.baseUrl);
  const modelName = requiredText(options.input.modelName, "模型名称", 100);
  const apiKey = String(options.input.apiKey ?? "").trim();
  if (!existing?.encrypted_api_key && !apiKey) throw new Error("首次配置必须填写 API Key");
  if (apiKey.length > 4096) throw new Error("API Key 长度无效");
  const encryptedApiKey = apiKey
    ? await encryptIntegrationSecret(apiKey)
    : existing?.encrypted_api_key ?? "";
  const maskedApiKey = apiKey
    ? maskedIntegrationSecret(apiKey)
    : existing?.masked_api_key ?? "";
  const enabled = options.input.enabled !== false;

  const result = await database.query<ProfileRow>(`
    INSERT INTO llm_profiles (
      id, name, provider_name, base_url, model_name, encrypted_api_key,
      masked_api_key, enabled, created_by_user_id, updated_by_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      provider_name = EXCLUDED.provider_name,
      base_url = EXCLUDED.base_url,
      model_name = EXCLUDED.model_name,
      encrypted_api_key = EXCLUDED.encrypted_api_key,
      masked_api_key = EXCLUDED.masked_api_key,
      enabled = EXCLUDED.enabled,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
    RETURNING *
  `, [
    id,
    name,
    providerName,
    baseUrl,
    modelName,
    encryptedApiKey,
    maskedApiKey,
    enabled,
    requiredText(options.actorUserId, "操作人", 160),
  ]);
  return profileFromRow(result.rows[0]);
}

export async function bindAgentRole(database: Queryable, options: {
  actorUserId: string;
  role: string;
  profileId: string;
  enabled?: boolean;
}) {
  assertAgentRole(options.role);
  const actorUserId = requiredText(options.actorUserId, "操作人", 160);
  const profileId = requiredText(options.profileId, "模型 Profile", 160);
  const exists = await database.query("SELECT 1 FROM llm_profiles WHERE id = $1", [profileId]);
  if (!exists.rows[0]) throw new Error("模型 Profile 不存在");
  const result = await database.query<BindingRow>(`
    INSERT INTO agent_role_bindings (
      id, role, llm_profile_id, enabled, updated_by_user_id
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (role) DO UPDATE SET
      llm_profile_id = EXCLUDED.llm_profile_id,
      enabled = EXCLUDED.enabled,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
    RETURNING id, role, llm_profile_id, enabled, updated_at,
      '' AS model_name, '' AS profile_name, '' AS provider_name,
      '' AS base_url, '' AS encrypted_api_key, '' AS masked_api_key,
      false AS profile_enabled
  `, [crypto.randomUUID(), options.role, profileId, options.enabled !== false, actorUserId]);
  const row = result.rows[0];
  return {
    id: row.id,
    role: row.role,
    profileId: row.llm_profile_id,
    enabled: row.enabled,
    updatedAt: row.updated_at,
  };
}

async function bindingRows(database: Queryable) {
  const result = await database.query<BindingRow>(`
    SELECT binding.id, binding.role, binding.llm_profile_id, binding.enabled,
           binding.updated_at, profile.name AS profile_name,
           profile.provider_name, profile.base_url, profile.model_name,
           profile.encrypted_api_key, profile.masked_api_key,
           profile.enabled AS profile_enabled
    FROM agent_role_bindings AS binding
    JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
    ORDER BY binding.role
  `);
  return result.rows;
}

export async function listAgentRoleBindings(database: Queryable, options: {
  visibility: "administrator" | "customer";
}) {
  const rows = await bindingRows(database);
  if (options.visibility === "customer") {
    return rows.map(row => ({
      role: row.role,
      modelName: row.model_name,
      enabled: row.enabled && row.profile_enabled,
      configured: true,
    }));
  }
  return rows.map(row => ({
    id: row.id,
    role: row.role,
    profileId: row.llm_profile_id,
    profileName: row.profile_name,
    providerName: row.provider_name,
    baseUrl: row.base_url,
    modelName: row.model_name,
    maskedApiKey: row.masked_api_key,
    enabled: row.enabled,
    profileEnabled: row.profile_enabled,
    configured: row.enabled && row.profile_enabled && Boolean(row.encrypted_api_key),
    updatedAt: row.updated_at,
  }));
}

export async function missingAgentRoles(database: Queryable) {
  const result = await database.query<{ role: AgentRole }>(`
    SELECT required.role
    FROM unnest($1::text[]) AS required(role)
    LEFT JOIN agent_role_bindings AS binding
      ON binding.role = required.role AND binding.enabled = true
    LEFT JOIN llm_profiles AS profile
      ON profile.id = binding.llm_profile_id
      AND profile.enabled = true
      AND profile.encrypted_api_key <> ''
    WHERE profile.id IS NULL
    ORDER BY array_position($1::text[], required.role)
  `, [agentRoles]);
  return result.rows.map(row => row.role);
}

export async function resolveAgentRoleConfig(database: Queryable, role: string) {
  assertAgentRole(role);
  const result = await database.query<BindingRow>(`
    SELECT binding.id, binding.role, binding.llm_profile_id, binding.enabled,
           binding.updated_at, profile.name AS profile_name,
           profile.provider_name, profile.base_url, profile.model_name,
           profile.encrypted_api_key, profile.masked_api_key,
           profile.enabled AS profile_enabled
    FROM agent_role_bindings AS binding
    JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
    WHERE binding.role = $1
      AND binding.enabled = true
      AND profile.enabled = true
      AND profile.encrypted_api_key <> ''
  `, [role]);
  const row = result.rows[0];
  if (!row) return null;
  const target = normalizeLlmCompletionEndpoint(row.base_url);
  return {
    role: row.role,
    profileId: row.llm_profile_id,
    model: row.model_name,
    modelName: row.model_name,
    providerName: row.provider_name,
    endpoint: target.endpoint,
    apiStyle: target.apiStyle,
    apiKey: await decryptIntegrationSecret(row.encrypted_api_key),
  };
}
