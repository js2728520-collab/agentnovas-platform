import type {
  AiRoleKey,
  BindingPolicy,
  BudgetPolicy,
  ControlPlaneSnapshot,
  ModelDeployment,
  ProbeReceipt,
  ProviderConnection,
} from "@agentnovas/ai-control-plane";
import type { Pool, PoolClient, QueryResultRow } from "pg";

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
  created_at: Date;
  updated_at: Date;
};

type DeploymentRow = QueryResultRow & {
  id: string;
  name: string;
  enabled: boolean;
  current_revision_id: string | null;
  connection_id: string | null;
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
};

type ProbeRow = QueryResultRow & {
  id: string;
  config_fingerprint: string;
  status: "requested" | "processing" | "succeeded" | "failed" | "cancelled";
  tested_at: Date;
  latency_ms: number | null;
  error_class: string | null;
  discovered_model_ids_json: unknown;
};

type BudgetRow = QueryResultRow & {
  id: string;
  scope_kind: BudgetPolicy["scope"];
  scope_key: string;
  unit: BudgetPolicy["unit"];
  limit_amount: string;
  warning_threshold_percent: number;
  enabled: boolean;
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
  const [connectionResult,deploymentResult,bindingResult,probeResult,budgetResult] = await Promise.all([
    database.query<ConnectionRow>(`
      SELECT id,name,adapter_id,enabled,current_revision_id,created_at,updated_at
      FROM maintenance_ai_connections_safe ORDER BY name,id
    `),
    database.query<DeploymentRow>(`
      SELECT id,name,enabled,current_revision_id,connection_id,created_at,updated_at
      FROM maintenance_ai_deployments_safe ORDER BY name,id
    `),
    database.query<BindingRow>(`
      SELECT binding_policy_id AS id,role,binding_policy_revision_id AS current_revision_id,
             runtime_state<>'disabled' AS enabled,target_rank,deployment_id
      FROM maintenance_ai_control_plane_snapshot_safe
      ORDER BY role,target_rank
    `),
    database.query<ProbeRow>(`
      SELECT id,config_fingerprint,status,tested_at,latency_ms,error_class,discovered_model_ids_json
      FROM maintenance_ai_probe_receipts_safe ORDER BY tested_at DESC LIMIT 100
    `),
    database.query<BudgetRow>(`
      SELECT id,scope_kind,scope_key,unit,limit_amount::text,warning_threshold_percent,enabled
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
  }));
  const deployments: ModelDeployment[] = deploymentResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    connectionId: row.connection_id ?? "",
    enabled: row.enabled,
    currentRevisionId: row.current_revision_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
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
      targets: rows.flatMap((row) => row.deployment_id === null || row.target_rank === null
        ? []
        : [{ deploymentId: row.deployment_id, priority: row.target_rank }]),
    };
  });
  const probes: ProbeReceipt[] = probeResult.rows.map((row) => ({
    id: row.id,
    configurationFingerprint: row.config_fingerprint,
    status: probeStatus(row.status),
    testedAt: iso(row.tested_at),
    expiresAt: new Date(row.tested_at.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }),
    ...(row.error_class === null ? {} : { errorCode: row.error_class }),
    models: Array.isArray(row.discovered_model_ids_json)
      ? row.discovered_model_ids_json.filter((value): value is string => typeof value === "string")
      : [],
  }));
  const budgets: BudgetPolicy[] = budgetResult.rows.map((row) => ({
    id: row.id,
    scope: row.scope_kind,
    scopeId: row.scope_key,
    unit: row.unit,
    limit: row.limit_amount,
    warningPercentage: row.warning_threshold_percent,
    enabled: row.enabled,
  }));

  return { connections,deployments,bindings,probes,budgets };
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
