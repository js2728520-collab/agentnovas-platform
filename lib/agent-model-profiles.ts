import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  decryptIntegrationSecret,
  encryptIntegrationSecret,
  maskedIntegrationSecret,
} from "./integration-credentials.ts";
import { normalizeLlmBaseUrl, normalizeLlmCompletionEndpoint } from "./llm-endpoint.ts";
import type { ResolvedAgentRoleConfig, ResolvedLlmProfileConfig } from "./research-types.ts";

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

export const runtimeExplanationRoles = [
  "market_summary",
  "adversarial_explanation",
  "risk_explanation",
] as const;

export type RuntimeExplanationRole = typeof runtimeExplanationRoles[number];

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
  current_revision_id: string | null;
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
  revision_id: string;
  revision_number: number;
  updated_at: Date;
};

type RevisionRow = QueryResultRow & {
  id: string;
  profile_id: string;
  revision_number: number;
  name: string;
  provider_name: string;
  base_url: string;
  model_name: string;
  encrypted_api_key: string;
  masked_api_key: string;
  enabled: boolean;
};

type RuntimeBindingRow = QueryResultRow & {
  id: string;
  role: RuntimeExplanationRole;
  llm_profile_id: string;
  enabled: boolean;
  model_name: string;
  profile_name: string;
  provider_name: string;
  base_url: string;
  encrypted_api_key: string;
  masked_api_key: string;
  profile_enabled: boolean;
  revision_id: string;
  revision_number: number;
  updated_at: Date;
};

type CustomerBindingView<Role extends string> = {
  role: Role; modelName: string; enabled: boolean; configured: boolean;
};

type AdministratorBindingView<Role extends string> = CustomerBindingView<Role> & {
  id: string; profileId: string; revisionId: string; revisionNumber: number;
  profileName: string; providerName: string; baseUrl: string; maskedApiKey: string;
  profileEnabled: boolean; updatedAt: Date;
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

function assertRuntimeExplanationRole(role: string): asserts role is RuntimeExplanationRole {
  if (!runtimeExplanationRoles.includes(role as RuntimeExplanationRole)) throw new Error("不支持的运行时解释角色");
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
    currentRevisionId: row.current_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listLlmProfiles(database: Queryable) {
  const result = await database.query<ProfileRow>(`
    SELECT id, name, provider_name, base_url, model_name, encrypted_api_key,
           masked_api_key, enabled, current_revision_id, created_at, updated_at
    FROM llm_profiles
    ORDER BY name, id
  `);
  return result.rows.map(profileFromRow);
}

async function runtimeBindingRows(database: Queryable) {
  const result = await database.query<RuntimeBindingRow>(`
    SELECT binding.id, binding.role, binding.llm_profile_id, binding.enabled,
           binding.updated_at, profile.name AS profile_name,
           revision.provider_name, revision.base_url, revision.model_name,
           revision.encrypted_api_key, revision.masked_api_key,
           revision.id AS revision_id, revision.revision_number,
           profile.enabled AS profile_enabled
    FROM runtime_explanation_bindings AS binding
    JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
    JOIN llm_profile_revisions AS revision ON revision.id = profile.current_revision_id
    ORDER BY binding.role
  `);
  return result.rows;
}

export async function bindRuntimeExplanationRole(database: Queryable, options: {
  actorUserId: string;
  role: string;
  profileId: string;
  enabled?: boolean;
}) {
  assertRuntimeExplanationRole(options.role);
  const actorUserId = requiredText(options.actorUserId, "操作人", 160);
  const profileId = requiredText(options.profileId, "模型 Profile", 160);
  const exists = await database.query("SELECT 1 FROM llm_profiles WHERE id = $1", [profileId]);
  if (!exists.rows[0]) throw new Error("模型 Profile 不存在");
  const result = await database.query<{ id: string; role: RuntimeExplanationRole; llm_profile_id: string; enabled: boolean; updated_at: Date }>(`
    INSERT INTO runtime_explanation_bindings (
      id, role, llm_profile_id, enabled, updated_by_user_id
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (role) DO UPDATE SET
      llm_profile_id = EXCLUDED.llm_profile_id,
      enabled = EXCLUDED.enabled,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
    RETURNING id, role, llm_profile_id, enabled, updated_at
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

export async function listRuntimeExplanationBindings(database: Queryable, options: { visibility: "administrator" }): Promise<AdministratorBindingView<RuntimeExplanationRole>[]>;
export async function listRuntimeExplanationBindings(database: Queryable, options: { visibility: "customer" }): Promise<CustomerBindingView<RuntimeExplanationRole>[]>;
export async function listRuntimeExplanationBindings(database: Queryable, options: {
  visibility: "administrator" | "customer";
}) {
  const rows = await runtimeBindingRows(database);
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
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
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

export async function saveLlmProfile(database: Queryable, options: {
  actorUserId: string;
  id?: string;
  input: LlmProfileInput;
}) {
  const id = options.id ?? crypto.randomUUID();
  const pool = database as Queryable & { connect?: () => Promise<PoolClient> };
  const client = pool.connect ? await pool.connect() : database as PoolClient;
  const release = Boolean(pool.connect);
  try {
    await client.query("BEGIN");
    const existing = options.id
      ? (await client.query<ProfileRow>("SELECT * FROM llm_profiles WHERE id = $1 FOR UPDATE", [id])).rows[0]
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
    const actorUserId = requiredText(options.actorUserId, "操作人", 160);

    const result = await client.query<ProfileRow>(`
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
    `, [id, name, providerName, baseUrl, modelName, encryptedApiKey, maskedApiKey, enabled, actorUserId]);
    const revisionId = crypto.randomUUID();
    await client.query(`
      INSERT INTO llm_profile_revisions (
        id, profile_id, revision_number, name, provider_name, base_url,
        model_name, encrypted_api_key, masked_api_key, enabled, created_by_user_id
      ) SELECT $1, $2, COALESCE(MAX(revision_number), 0) + 1,
               $3, $4, $5, $6, $7, $8, $9, $10
        FROM llm_profile_revisions WHERE profile_id = $2
    `, [revisionId, id, name, providerName, baseUrl, modelName, encryptedApiKey, maskedApiKey, enabled, actorUserId]);
    const updated = await client.query<ProfileRow>(`
      UPDATE llm_profiles SET current_revision_id = $2 WHERE id = $1 RETURNING *
    `, [id, revisionId]);
    await client.query("COMMIT");
    return profileFromRow(updated.rows[0] ?? result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (release) client.release();
  }
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
           revision.provider_name, revision.base_url, revision.model_name,
           revision.encrypted_api_key, revision.masked_api_key,
           revision.id AS revision_id, revision.revision_number,
           profile.enabled AS profile_enabled
    FROM agent_role_bindings AS binding
    JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
    JOIN llm_profile_revisions AS revision ON revision.id = profile.current_revision_id
    ORDER BY binding.role
  `);
  return result.rows;
}

export async function listAgentRoleBindings(database: Queryable, options: { visibility: "administrator" }): Promise<AdministratorBindingView<AgentRole>[]>;
export async function listAgentRoleBindings(database: Queryable, options: { visibility: "customer" }): Promise<CustomerBindingView<AgentRole>[]>;
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
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
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
    LEFT JOIN llm_profile_revisions AS revision
      ON revision.id = profile.current_revision_id
      AND revision.enabled = true
      AND revision.encrypted_api_key <> ''
    WHERE revision.id IS NULL
    ORDER BY array_position($1::text[], required.role)
  `, [agentRoles]);
  return result.rows.map(row => row.role);
}

export async function snapshotAgentRoleBindings(database: Queryable) {
  const rows = await bindingRows(database);
  const roles = Object.fromEntries(rows
    .filter(row => row.enabled && row.profile_enabled && Boolean(row.encrypted_api_key))
    .map(row => [row.role, {
      profileId: row.llm_profile_id,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      modelName: row.model_name,
    }]));
  const missingRoles = agentRoles.filter(role => !roles[role]);
  return { roles: roles as Partial<Record<AgentRole, { profileId: string; revisionId: string; revisionNumber: number; modelName: string }>>, missingRoles };
}

export async function resolveAgentRoleConfig(database: Queryable, role: string, options: {
  revisionId?: string;
} = {}): Promise<ResolvedAgentRoleConfig | null> {
  assertAgentRole(role);
  if (options.revisionId) {
    const revisionResult = await database.query<RevisionRow>(`
      SELECT id, profile_id, revision_number, name, provider_name, base_url,
             model_name, encrypted_api_key, masked_api_key, enabled
      FROM llm_profile_revisions
      WHERE id = $1 AND enabled = true AND encrypted_api_key <> ''
    `, [options.revisionId]);
    const revision = revisionResult.rows[0];
    if (!revision) return null;
    const target = normalizeLlmCompletionEndpoint(revision.base_url);
    return {
      role,
      profileId: revision.profile_id,
      revisionId: revision.id,
      revisionNumber: revision.revision_number,
      model: revision.model_name,
      modelName: revision.model_name,
      providerName: revision.provider_name,
      endpoint: target.endpoint,
      apiStyle: target.apiStyle,
      apiKey: await decryptIntegrationSecret(revision.encrypted_api_key),
    };
  }
  const result = await database.query<BindingRow>(`
    SELECT binding.id, binding.role, binding.llm_profile_id, binding.enabled,
           binding.updated_at, profile.name AS profile_name,
           revision.provider_name, revision.base_url, revision.model_name,
           revision.encrypted_api_key, revision.masked_api_key,
           revision.id AS revision_id, revision.revision_number,
           profile.enabled AS profile_enabled
    FROM agent_role_bindings AS binding
    JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
    JOIN llm_profile_revisions AS revision ON revision.id = profile.current_revision_id
    WHERE binding.role = $1
      AND binding.enabled = true
      AND profile.enabled = true
      AND revision.enabled = true
      AND revision.encrypted_api_key <> ''
  `, [role]);
  const row = result.rows[0];
  if (!row) return null;
  const target = normalizeLlmCompletionEndpoint(row.base_url);
  return {
    role: row.role,
    profileId: row.llm_profile_id,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    model: row.model_name,
    modelName: row.model_name,
    providerName: row.provider_name,
    endpoint: target.endpoint,
    apiStyle: target.apiStyle,
    apiKey: await decryptIntegrationSecret(row.encrypted_api_key),
  };
}

export async function resolveRuntimeExplanationRoleConfig(database: Queryable, role: string, options: {
  revisionId?: string;
} = {}): Promise<ResolvedLlmProfileConfig<RuntimeExplanationRole> | null> {
  assertRuntimeExplanationRole(role);
  if (options.revisionId) {
    const revisionResult = await database.query<RevisionRow>(`
      SELECT id, profile_id, revision_number, name, provider_name, base_url,
             model_name, encrypted_api_key, masked_api_key, enabled
      FROM llm_profile_revisions
      WHERE id = $1 AND enabled = true AND encrypted_api_key <> ''
    `, [options.revisionId]);
    const revision = revisionResult.rows[0];
    if (!revision) return null;
    const target = normalizeLlmCompletionEndpoint(revision.base_url);
    return {
      role,
      profileId: revision.profile_id,
      revisionId: revision.id,
      revisionNumber: revision.revision_number,
      model: revision.model_name,
      modelName: revision.model_name,
      providerName: revision.provider_name,
      endpoint: target.endpoint,
      apiStyle: target.apiStyle,
      apiKey: await decryptIntegrationSecret(revision.encrypted_api_key),
    };
  }
  const result = await database.query<RuntimeBindingRow>(`
    SELECT binding.id, binding.role, binding.llm_profile_id, binding.enabled,
           binding.updated_at, profile.name AS profile_name,
           revision.provider_name, revision.base_url, revision.model_name,
           revision.encrypted_api_key, revision.masked_api_key,
           revision.id AS revision_id, revision.revision_number,
           profile.enabled AS profile_enabled
    FROM runtime_explanation_bindings AS binding
    JOIN llm_profiles AS profile ON profile.id = binding.llm_profile_id
    JOIN llm_profile_revisions AS revision ON revision.id = profile.current_revision_id
    WHERE binding.role = $1
      AND binding.enabled = true
      AND profile.enabled = true
      AND revision.enabled = true
      AND revision.encrypted_api_key <> ''
  `, [role]);
  const row = result.rows[0];
  if (!row) return null;
  const target = normalizeLlmCompletionEndpoint(row.base_url);
  return {
    role: row.role,
    profileId: row.llm_profile_id,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    model: row.model_name,
    modelName: row.model_name,
    providerName: row.provider_name,
    endpoint: target.endpoint,
    apiStyle: target.apiStyle,
    apiKey: await decryptIntegrationSecret(row.encrypted_api_key),
  };
}
