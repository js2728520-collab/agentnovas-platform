import type {
  AiRoleKey,
  BindingPolicy,
  BudgetPolicy,
  ControlPlaneSnapshot,
  DeploymentRevision,
  ModelDeployment,
  ProbeReceipt,
  ProviderConnection,
} from "@agentnovas/ai-control-plane";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { SecretEnvelopeCommand } from "@agentnovas/ai-control-plane";

type Queryable = Pick<Pool | PoolClient, "query">;

const roleKeys = {
  requirements: "research.requirements",
  market_regime: "research.market_regime",
  proposal_a: "research.proposal_a",
  proposal_b: "research.proposal_b",
  adversarial_review: "research.adversarial_review",
  risk_review: "research.risk_review",
  report: "research.report",
  market_summary: "runtime.market_summary",
  adversarial_explanation: "runtime.adversarial_explanation",
  risk_explanation: "runtime.risk_explanation",
  assistant_message: "client.assistant_message",
  strategy_generation: "client.strategy_generation",
} as const satisfies Record<string, AiRoleKey>;

type ConnectionRow = QueryResultRow & {
  id: string;
  name: string;
  adapter_id: string;
  enabled: boolean;
  current_revision_id: string | null;
  has_secret: boolean;
  created_at: Date;
  updated_at: Date;
};

type DeploymentRow = QueryResultRow & {
  id: string;
  name: string;
  enabled: boolean;
  current_revision_id: string | null;
  connection_id: string | null;
  model_id: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_streaming: boolean | null;
  supports_structured_output: boolean | null;
  rate_card_revision_id: string | null;
  currency: string | null;
  input_cost_per_million: string | null;
  output_cost_per_million: string | null;
  cached_input_cost_per_million: string | null;
  rate_effective_from: Date | null;
  created_at: Date;
  updated_at: Date;
};

type BindingRow = QueryResultRow & {
  id: string;
  role: keyof typeof roleKeys;
  current_revision_id: string | null;
  enabled: boolean;
  target_rank: number | null;
  deployment_id: string | null;
  deployment_revision_id: string | null;
  runtime_state: "active" | "gated" | "disabled" | "retired";
};

type ProbeRow = QueryResultRow & {
  id: string;
  config_fingerprint: string;
  phase: NonNullable<ProbeReceipt["phase"]>;
  status: "requested" | "processing" | "succeeded" | "failed" | "cancelled";
  tested_at: Date;
  is_expired: boolean;
  latency_ms: number | null;
  error_class: string | null;
  discovered_model_ids_json: unknown;
  deployment_revision_id: string | null;
};

type BudgetRow = QueryResultRow & {
  id: string;
  scope_kind: BudgetPolicy["scope"];
  scope_key: string;
  unit: BudgetPolicy["unit"];
  limit_amount: string;
  warning_threshold_percent: number;
  enabled: boolean;
  period: "day" | "month";
};

type DeploymentRevisionRow = QueryResultRow & {
  id: string;deployment_id: string;revision_number: number;deployment_name: string;
  connection_id: string;connection_name: string;model_id: string;context_window: number | null;
  max_output_tokens: number | null;supports_streaming: boolean;supports_structured_output: boolean;
  has_secret: boolean;is_current: boolean;deployment_enabled: boolean;created_at: Date;
  rate_card_revision_id: string | null;currency: string | null;input_cost_per_million: string | null;
  output_cost_per_million: string | null;cached_input_cost_per_million: string | null;
  rate_effective_from: Date | null;
};

function iso(value: Date) {
  return new Date(value).toISOString();
}

function probeStatus(status: ProbeRow["status"]): ProbeReceipt["status"] {
  if (status === "requested") return "pending";
  if (status === "processing") return "running";
  return status === "succeeded" ? "succeeded" : "failed";
}

export async function getAiControlPlaneSnapshot(database: Queryable): Promise<ControlPlaneSnapshot> {
  const [connectionResult,deploymentResult,revisionResult,bindingResult,probeResult,budgetResult] = await Promise.all([
    database.query<ConnectionRow>(`
      SELECT id,name,adapter_id,enabled,current_revision_id,has_secret,created_at,updated_at
      FROM maintenance_ai_connections_safe ORDER BY name,id
    `),
    database.query<DeploymentRow>(`
      SELECT id,name,enabled,current_revision_id,connection_id,model_id,context_window,max_output_tokens,
             supports_streaming,supports_structured_output,rate_card_revision_id,currency,
             input_cost_per_million::text,output_cost_per_million::text,
             cached_input_cost_per_million::text,rate_effective_from,created_at,updated_at
      FROM maintenance_ai_deployments_safe ORDER BY name,id
    `),
    database.query<DeploymentRevisionRow>(`
      SELECT id,deployment_id,revision_number,deployment_name,connection_id,connection_name,model_id,
             context_window,max_output_tokens,supports_streaming,supports_structured_output,has_secret,
             is_current,deployment_enabled,created_at,rate_card_revision_id,currency,
             input_cost_per_million::text,output_cost_per_million::text,
             cached_input_cost_per_million::text,rate_effective_from
      FROM maintenance_ai_deployment_revisions_safe
      ORDER BY deployment_name,revision_number DESC,id LIMIT 200
    `),
    database.query<BindingRow>(`
      SELECT binding_policy_id AS id,role,binding_policy_revision_id AS current_revision_id,
             runtime_state<>'disabled' AS enabled,runtime_state,target_rank,deployment_id,deployment_revision_id
      FROM maintenance_ai_control_plane_snapshot_safe
      ORDER BY role,target_rank
    `),
    database.query<ProbeRow>(`
      SELECT id,deployment_revision_id,config_fingerprint,status,tested_at,latency_ms,error_class,
             discovered_model_ids_json,phase,tested_at < now()-interval '24 hours' AS is_expired
      FROM maintenance_ai_probe_receipts_safe ORDER BY tested_at DESC LIMIT 100
    `),
    database.query<BudgetRow>(`
      SELECT id,scope_kind,scope_key,period,unit,limit_amount::text,warning_threshold_percent,enabled
      FROM maintenance_ai_budgets_safe ORDER BY scope_kind,scope_key,id
    `),
  ]);

  const connections: ProviderConnection[] = connectionResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    adapterId: row.adapter_id,
    enabled: row.enabled,
    currentRevisionId: row.current_revision_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    hasSecret: row.has_secret,
  }));
  const deployments: ModelDeployment[] = deploymentResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    connectionId: row.connection_id ?? "",
    enabled: row.enabled,
    currentRevisionId: row.current_revision_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.model_id === null ? {} : { modelId: row.model_id }),
    contextWindowTokens: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    ...(row.supports_streaming === null ? {} : { supportsStreaming: row.supports_streaming }),
    ...(row.supports_structured_output === null ? {} : { supportsStructuredOutput: row.supports_structured_output }),
    rateCard: row.rate_card_revision_id && row.currency && row.input_cost_per_million
      && row.output_cost_per_million && row.rate_effective_from
      ? {
        id: row.rate_card_revision_id,deploymentId: row.id,currency: row.currency,
        inputPerMillion: row.input_cost_per_million,outputPerMillion: row.output_cost_per_million,
        cachedInputPerMillion: row.cached_input_cost_per_million,
        effectiveAt: iso(row.rate_effective_from),
      }
      : null,
  }));
  const bindingRows = new Map<string, BindingRow[]>();
  for (const row of bindingResult.rows) {
    const rows = bindingRows.get(row.id) ?? [];
    rows.push(row);
    bindingRows.set(row.id, rows);
  }
  const bindings: BindingPolicy[] = [...bindingRows.values()].map((rows) => {
    const first = rows[0];
    return {
      id: first.id,
      roleKey: roleKeys[first.role],
      revisionId: first.current_revision_id ?? "",
      enabled: first.enabled,
      runtimeState: first.runtime_state,
      targets: rows.flatMap((row) => row.deployment_id === null || row.target_rank === null
        ? []
        : [{ deploymentId: row.deployment_id,deploymentRevisionId: row.deployment_revision_id ?? undefined,priority: row.target_rank }]),
    };
  });
  const probes: ProbeReceipt[] = probeResult.rows.map((row) => ({
    id: row.id,
    configurationFingerprint: row.config_fingerprint,
    phase: row.phase,
    status: probeStatus(row.status),
    testedAt: iso(row.tested_at),
    expiresAt: new Date(row.tested_at.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    isExpired: row.is_expired,
    ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
    ...(row.error_class === null ? {} : { errorCode: row.error_class }),
    models: Array.isArray(row.discovered_model_ids_json)
      ? row.discovered_model_ids_json.filter((value): value is string => typeof value === "string")
      : [],
    deploymentRevisionId: row.deployment_revision_id,
  }));
  const budgets: BudgetPolicy[] = budgetResult.rows.map((row) => ({
    id: row.id,
    scope: row.scope_kind,
    scopeId: row.scope_key,
    unit: row.unit,
    limit: row.limit_amount,
    warningPercentage: row.warning_threshold_percent,
    enabled: row.enabled,
    period: row.period,
  }));

  const deploymentRevisions: DeploymentRevision[] = revisionResult.rows.map((row) => ({
    id: row.id,deploymentId: row.deployment_id,revisionNumber: row.revision_number,
    modelId: row.model_id,connectionId: row.connection_id,deploymentName: row.deployment_name,
    connectionName: row.connection_name,isCurrent: row.is_current,hasSecret: row.has_secret,
    enabled: row.deployment_enabled && row.is_current,createdAt: iso(row.created_at),
    capability: {
      inputModalities: ["text"],outputModalities: ["text"],
      contextWindowTokens: row.context_window ?? 0,maxOutputTokens: row.max_output_tokens ?? 0,
      supportsStreaming: row.supports_streaming,supportsStructuredOutput: row.supports_structured_output,
    },
    defaultMaxOutputTokens: row.max_output_tokens ?? 4_096,defaultTimeoutMs: 30_000,
    rateCard: row.rate_card_revision_id && row.currency && row.input_cost_per_million
      && row.output_cost_per_million && row.rate_effective_from
      ? {
        id: row.rate_card_revision_id,deploymentId: row.deployment_id,currency: row.currency,
        inputPerMillion: row.input_cost_per_million,outputPerMillion: row.output_cost_per_million,
        cachedInputPerMillion: row.cached_input_cost_per_million,effectiveAt: iso(row.rate_effective_from),
      }
      : null,
  }));

  return { connections,deployments,deploymentRevisions,bindings,probes,budgets };
}

async function controlPlaneAvailable(database: Queryable) {
  const result = await database.query<{ available: boolean }>(
    "SELECT to_regclass('ai_provider_connections') IS NOT NULL AS available",
  );
  return result.rows[0]?.available === true;
}

/**
 * Additive facade used by legacy profile APIs during the compatibility window.
 * It intentionally copies no legacy ciphertext into the new custody model.
 */
export async function synchronizeLegacyProfile(database: Queryable, profileId: string) {
  if (!await controlPlaneAvailable(database)) return { synchronized: false };
  const result = await database.query<{ synchronized: boolean }>(
    "SELECT ai_sync_legacy_profile($1) AS synchronized",
    [profileId],
  );
  return { synchronized: result.rows[0]?.synchronized === true };
}

export async function synchronizeLegacyBinding(database: Queryable, role: keyof typeof roleKeys) {
  if (!await controlPlaneAvailable(database)) return { synchronized: false };
  const revisionId = crypto.randomUUID();
  const result = await database.query<{ synchronized: boolean }>(
    "SELECT ai_sync_legacy_binding($1,$2) AS synchronized",
    [role,revisionId],
  );
  return result.rows[0]?.synchronized === true
    ? { synchronized: true,revisionId }
    : { synchronized: false };
}

export type SaveConnectionDeploymentInput = {
  connectionId: string;
  connectionRevisionId: string;
  connectionName: string;
  endpoint: string;
  deploymentId: string;
  deploymentRevisionId: string;
  deploymentName: string;
  modelId: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  rateCardRevisionId: string | null;
  rateCard: {
    currency: string;
    inputPerMillion: string;
    outputPerMillion: string;
    cachedInputPerMillion: string | null;
  } | null;
  actorUserId: string;
  reason: string;
  requestId: string;
};

export async function saveConnectionDeployment(database: Queryable, input: SaveConnectionDeploymentInput) {
  const result = await database.query<{ value: {
    connectionId: string;
    connectionRevisionId: string;
    deploymentId: string;
    deploymentRevisionId: string;
    configurationFingerprint: string;
    rateCardRevisionId: string | null;
  } }>(`SELECT ai_save_connection_deployment_with_rate_card(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
  ) AS value`,[
    input.connectionId,input.connectionRevisionId,input.connectionName,input.endpoint,
    input.deploymentId,input.deploymentRevisionId,input.deploymentName,input.modelId,
    input.contextWindow,input.maxOutputTokens,input.supportsStreaming,input.supportsStructuredOutput,
    input.rateCardRevisionId,input.rateCard?.currency ?? null,input.rateCard?.inputPerMillion ?? null,
    input.rateCard?.outputPerMillion ?? null,input.rateCard?.cachedInputPerMillion ?? null,
    input.actorUserId,input.reason,input.requestId,
  ]);
  return result.rows[0].value;
}

export async function enqueueSecretCommand(database: Queryable, input: {
  envelope: SecretEnvelopeCommand;
  actorUserId: string;
  idempotencyKey: string;
  reason: string;
  requestId: string;
}) {
  const envelope = input.envelope;
  const result = await database.query<{ id: string }>(`SELECT ai_enqueue_secret_command(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
  ) AS id`,[
    envelope.commandId,envelope.targetConnectionRevisionId,envelope.brokerKeyId,envelope.algorithm,
    envelope.wrappedDataKey,envelope.iv,envelope.ciphertext,envelope.authTag,envelope.envelopeDigestSha256,
    input.actorUserId,input.idempotencyKey,input.reason,input.requestId,
  ]);
  return { commandId: result.rows[0].id };
}

export async function updateBindingPolicy(database: Queryable, input: {
  roleKey: AiRoleKey;
  revisionId: string;
  deploymentRevisionIds: string[];
  enabled: boolean;
  actorUserId: string;
  reason: string;
  requestId: string;
}) {
  const role = Object.entries(roleKeys).find(([,key]) => key === input.roleKey)?.[0];
  if (!role) throw new Error("AI_ROLE_INVALID");
  const result = await database.query<{ id: string }>(
    "SELECT ai_update_binding_policy($1,$2,$3::text[],$4,$5,$6,$7) AS id",
    [role,input.revisionId,input.deploymentRevisionIds,input.enabled,input.actorUserId,input.reason,input.requestId],
  );
  return { revisionId: result.rows[0].id };
}

export async function upsertBudgetPolicy(database: Queryable, input: {
  id: string;
  scope: BudgetPolicy["scope"];
  scopeId: string;
  period: "day" | "month";
  limit: string;
  unit: BudgetPolicy["unit"];
  enabled: boolean;
  actorUserId: string;
  reason: string;
  requestId: string;
}) {
  const result = await database.query<{ id: string }>(
    "SELECT ai_upsert_budget_policy($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS id",
    [input.id,input.scope,input.scopeId,input.period,input.limit,input.unit,input.enabled,
      input.actorUserId,input.reason,input.requestId],
  );
  return { budgetId: result.rows[0].id };
}

export async function readActiveSecretBrokerKey(database: Queryable) {
  return (await database.query<{
    key_id: string;
    algorithm: "RSA-OAEP-SHA256";
    public_key_spki_base64: string;
    fingerprint_sha256: string;
    not_before: Date;
    not_after: Date | null;
  }>(`SELECT key_id,algorithm,public_key_spki_base64,fingerprint_sha256,not_before,not_after
      FROM maintenance_ai_secret_broker_key_safe ORDER BY not_before DESC,key_id DESC LIMIT 1`)).rows[0] ?? null;
}

export async function createProbeRequest(database: Queryable, input: {
  id: string;
  deploymentRevisionId: string;
  actorUserId: string;
  reason: string;
  requestId: string;
}) {
  const result = await database.query<{ id: string }>(
    "SELECT ai_request_probe($1,$2,$3,$4,$5) AS id",
    [input.id,input.deploymentRevisionId,input.actorUserId,input.reason,input.requestId],
  );
  return { probeReceiptId: result.rows[0].id };
}

export async function rollbackControlPlaneDeployment(database: Queryable,input: {
  deploymentId: string;sourceRevisionId: string;expectedCurrentRevisionId: string;
  actorUserId: string;reason: string;requestId: string;
}) {
  const result = await database.query<{ value: {
    deploymentRevisionId: string;revisionNumber?: number;replayed: boolean;
  } }>("SELECT ai_rollback_deployment($1,$2,$3,$4,$5,$6,$7) AS value",[
    input.deploymentId,input.sourceRevisionId,input.expectedCurrentRevisionId,crypto.randomUUID(),
    input.actorUserId,input.reason,input.requestId,
  ]);
  return result.rows[0].value;
}
