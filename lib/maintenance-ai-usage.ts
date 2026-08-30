import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { ResearchApiError } from "./research-errors.ts";

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 90;
const DIMENSION_LIMIT = 50;

export type MaintenanceAiUsagePeriod = {
  from: string;
  to: string;
  timezone: "UTC";
};

type AggregateRow = {
  dimension_key?: string;
  group_key?: string;
  group_label?: string | null;
  provider_name?: string | null;
  model_name?: string | null;
  request_count: string | number;
  succeeded_count: string | number;
  failed_count: string | number;
  cancelled_count: string | number;
  processing_count: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  settled_credits: string | number;
  released_count: string | number;
  captured_organization_count: string | number;
  legacy_backfill_organization_count: string | number;
  legacy_unattributed_organization_count: string | number;
};

type UnifiedAggregateRow = {
  dimension_key: string;
  group_key: string | null;
  group_label: string | null;
  request_count: string | number;
  attempted_count: string | number;
  succeeded_count: string | number;
  failed_count: string | number;
  cancelled_count: string | number;
  processing_count: string | number;
  fallback_attempt_count: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cached_input_tokens: string | number;
  reasoning_tokens: string | number;
  settled_credits: string | number;
  unpriced_count: string | number;
  p50_queue_latency_ms: string | number | null;
  p95_queue_latency_ms: string | number | null;
  p50_provider_latency_ms: string | number | null;
  p95_provider_latency_ms: string | number | null;
  p50_total_latency_ms: string | number | null;
  p95_total_latency_ms: string | number | null;
};

type Queryable = Pick<Pool, "query">;
type SnapshotDatabase = Queryable & { connect?: Pool["connect"] };

function utcDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return timestamp;
}

function formatUtcDay(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function parseMaintenanceAiUsageWindow(
  parameters: URLSearchParams,
  now = new Date(),
): MaintenanceAiUsagePeriod {
  const suppliedFrom = parameters.get("from")?.trim() ?? "";
  const suppliedTo = parameters.get("to")?.trim() ?? "";
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!suppliedFrom && !suppliedTo) {
    return {
      from: formatUtcDay(today - 29 * DAY_MS),
      to: formatUtcDay(today),
      timezone: "UTC",
    };
  }
  const from = utcDay(suppliedFrom);
  const to = utcDay(suppliedTo);
  const invalid = from === null
    || to === null
    || from > to
    || to > today
    || Math.floor((to - from) / DAY_MS) + 1 > MAX_RANGE_DAYS;
  if (invalid) {
    throw new ResearchApiError(
      "AI_USAGE_DATE_RANGE_INVALID",
      "日期范围必须是 UTC 自然日、两端完整、不得晚于今天且最多 90 天",
      400,
      { fields: ["from", "to"], timezone: "UTC", maximumDays: MAX_RANGE_DAYS },
    );
  }
  return { from: suppliedFrom, to: suppliedTo, timezone: "UTC" };
}

export function maintenanceAiUsageUserRef(userId: string) {
  const digest = createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 12).toUpperCase();
  return `USR-${digest}`;
}

function count(value: string | number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("INVALID_AI_USAGE_COUNT");
  return parsed;
}

function exactInteger(value: string | number) {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error("INVALID_AI_USAGE_INTEGER");
  return text.replace(/^0+(?=\d)/, "");
}

function metrics(row?: AggregateRow) {
  const succeededCount = count(row?.succeeded_count ?? 0);
  const failedCount = count(row?.failed_count ?? 0);
  const terminalForReliability = succeededCount + failedCount;
  return {
    requestCount: count(row?.request_count ?? 0),
    succeededCount,
    recordedFailureCount: failedCount,
    cancelledCount: count(row?.cancelled_count ?? 0),
    processingCount: count(row?.processing_count ?? 0),
    inputTokens: exactInteger(row?.input_tokens ?? 0),
    outputTokens: exactInteger(row?.output_tokens ?? 0),
    settledCredits: exactInteger(row?.settled_credits ?? 0),
    releasedCount: count(row?.released_count ?? 0),
    recordedFailureRate: terminalForReliability ? failedCount / terminalForReliability : null,
    organizationAttribution: {
      capturedAtRequest: count(row?.captured_organization_count ?? 0),
      legacyCurrentBackfill: count(row?.legacy_backfill_organization_count ?? 0),
      legacyUnattributed: count(row?.legacy_unattributed_organization_count ?? 0),
    },
  };
}

const metricColumns = `
  COUNT(*)::text AS request_count,
  COALESCE(SUM(succeeded_count),0)::text AS succeeded_count,
  COALESCE(SUM(failed_count),0)::text AS failed_count,
  COALESCE(SUM(cancelled_count),0)::text AS cancelled_count,
  COALESCE(SUM(processing_count),0)::text AS processing_count,
  COALESCE(SUM(input_tokens),0)::text AS input_tokens,
  COALESCE(SUM(output_tokens),0)::text AS output_tokens,
  COALESCE(SUM(settled_credits),0)::text AS settled_credits,
  COALESCE(SUM(released_count),0)::text AS released_count,
  COUNT(*) FILTER (WHERE organization_attribution_mode='captured_at_request')::text AS captured_organization_count,
  COUNT(*) FILTER (WHERE organization_attribution_mode='legacy_current_backfill')::text AS legacy_backfill_organization_count,
  COUNT(*) FILTER (WHERE organization_attribution_mode='legacy_unattributed')::text AS legacy_unattributed_organization_count`;

function groupedBranch(
  dimension: string,
  selection: string,
  grouping: string,
  limit = DIMENSION_LIMIT + 1,
) {
  return `(SELECT '${dimension}'::text AS dimension_key,${selection},${metricColumns}
    FROM filtered
    GROUP BY ${grouping}
    ORDER BY COUNT(*) DESC,group_key ASC
    LIMIT ${limit})`;
}

function sortedDimensionRows(rows: AggregateRow[]) {
  return [...rows].sort((left, right) => {
    const byRequestCount = count(right.request_count) - count(left.request_count);
    if (byRequestCount) return byRequestCount;
    const leftKey = String(left.group_key ?? "");
    const rightKey = String(right.group_key ?? "");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function dimension<T>(rows: AggregateRow[], map: (row: AggregateRow) => T) {
  const sorted = sortedDimensionRows(rows);
  return {
    data: sorted.slice(0, DIMENSION_LIMIT).map(map),
    truncated: rows.length > DIMENSION_LIMIT,
  };
}

function orderedGroups<T>(rows: AggregateRow[], map: (row: AggregateRow) => T) {
  return sortedDimensionRows(rows).map(map);
}

function daysInPeriod(period: MaintenanceAiUsagePeriod) {
  const from = utcDay(period.from)!;
  const to = utcDay(period.to)!;
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor += DAY_MS) days.push(formatUtcDay(cursor));
  return days;
}

async function readMaintenanceAiUsage(queryable: Queryable, period: MaintenanceAiUsagePeriod) {
  const values = [period.from, period.to];
  const result = await queryable.query<AggregateRow>(`/* maintenance-ai-usage:report */
    WITH filtered AS MATERIALIZED (
      SELECT
        usage_day,user_pseudonym_source,organization_id,organization_name,
        organization_attribution_mode,profile_revision_id,provider_name,model_name,
        operation,agent_role,succeeded_count,failed_count,cancelled_count,
        processing_count,input_tokens,output_tokens,settled_credits,released_count
      FROM maintenance_ai_usage_events_safe
      WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
        AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
    )
    (SELECT
      'summary'::text AS dimension_key,
      NULL::text AS group_key,
      NULL::text AS group_label,
      NULL::text AS provider_name,
      NULL::text AS model_name,
      ${metricColumns}
    FROM filtered)
    UNION ALL
    ${groupedBranch("day", "usage_day::text AS group_key,NULL::text AS group_label,NULL::text AS provider_name,NULL::text AS model_name", "usage_day", MAX_RANGE_DAYS)}
    UNION ALL
    ${groupedBranch(
      "organization",
      "organization_id AS group_key,MAX(organization_name) AS group_label,NULL::text AS provider_name,NULL::text AS model_name",
      "organization_id",
    )}
    UNION ALL
    ${groupedBranch("user", "user_pseudonym_source AS group_key,NULL::text AS group_label,NULL::text AS provider_name,NULL::text AS model_name", "user_pseudonym_source")}
    UNION ALL
    ${groupedBranch(
      "model",
      "profile_revision_id AS group_key,NULL::text AS group_label,MAX(provider_name) AS provider_name,MAX(model_name) AS model_name",
      "profile_revision_id",
    )}
    UNION ALL
    ${groupedBranch("agent", "agent_role AS group_key,NULL::text AS group_label,NULL::text AS provider_name,NULL::text AS model_name", "agent_role")}
    UNION ALL
    ${groupedBranch("function", "operation AS group_key,NULL::text AS group_label,NULL::text AS provider_name,NULL::text AS model_name", "operation")}
  `, values);

  const rowsFor = (dimension: string) => result.rows.filter((row) => row.dimension_key === dimension);
  const summary = rowsFor("summary")[0];
  const byDayRows = rowsFor("day");
  const byOrganizationRows = rowsFor("organization");
  const byUserRows = rowsFor("user");
  const byModelRows = rowsFor("model");
  const byAgentRows = rowsFor("agent");
  const byFunctionRows = rowsFor("function");

  const dayMetrics = new Map(byDayRows.map((row) => [String(row.group_key), metrics(row)]));
  return {
    period,
    timeBasis: "request_created_at" as const,
    population: {
      included: "reserved_inference_requests" as const,
      failureNumerator: "non_cancelled_failed_terminal_requests" as const,
      excludes: ["preflight_rejections", "user_cancellations", "processing_requests"] as const,
    },
    pricing: { status: "decision_required" as const, blocker: "P-08" as const },
    summary: metrics(summary),
    byDay: daysInPeriod(period).map((key) => ({ key, ...(dayMetrics.get(key) ?? metrics()) })),
    byOrganization: dimension(byOrganizationRows, (row) => ({
      key: String(row.group_key),
      label: String(row.group_label || (row.group_key === "unattributed" ? "未归属" : row.group_key)),
      ...metrics(row),
    })),
    byUser: dimension(byUserRows, (row) => ({
      key: maintenanceAiUsageUserRef(String(row.group_key)),
      ...metrics(row),
    })),
    byModel: dimension(byModelRows, (row) => ({
      key: String(row.group_key),
      providerName: String(row.provider_name || "unknown"),
      modelName: String(row.model_name || "unknown"),
      ...metrics(row),
    })),
    byAgent: orderedGroups(byAgentRows, (row) => ({ key: String(row.group_key), ...metrics(row) })),
    byFunction: orderedGroups(byFunctionRows, (row) => ({ key: String(row.group_key), ...metrics(row) })),
  };
}

const unifiedMetricColumns = `
  COUNT(*) FILTER (WHERE event_kind='requested')::text AS request_count,
  COUNT(*) FILTER (WHERE event_kind='attempted')::text AS attempted_count,
  COUNT(*) FILTER (WHERE event_kind='succeeded')::text AS succeeded_count,
  COUNT(*) FILTER (WHERE event_kind='failed')::text AS failed_count,
  COUNT(*) FILTER (WHERE event_kind='cancelled')::text AS cancelled_count,
  COUNT(*) FILTER (WHERE event_kind='processing')::text AS processing_count,
  COUNT(*) FILTER (WHERE event_kind='attempted' AND fallback_rank>0)::text AS fallback_attempt_count,
  COALESCE(SUM(input_tokens),0)::text AS input_tokens,
  COALESCE(SUM(output_tokens),0)::text AS output_tokens,
  COALESCE(SUM(cached_input_tokens),0)::text AS cached_input_tokens,
  COALESCE(SUM(reasoning_tokens),0)::text AS reasoning_tokens,
  COALESCE(SUM(platform_settled_credits),0)::text AS settled_credits,
  COUNT(*) FILTER (WHERE event_kind='succeeded' AND pricing_state='unpriced')::text AS unpriced_count,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY queue_latency_ms)
    FILTER (WHERE event_kind IN ('succeeded','failed','cancelled') AND queue_latency_ms IS NOT NULL)::text AS p50_queue_latency_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY queue_latency_ms)
    FILTER (WHERE event_kind IN ('succeeded','failed','cancelled') AND queue_latency_ms IS NOT NULL)::text AS p95_queue_latency_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY provider_latency_ms)
    FILTER (WHERE event_kind IN ('succeeded','failed','cancelled') AND provider_latency_ms IS NOT NULL)::text AS p50_provider_latency_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY provider_latency_ms)
    FILTER (WHERE event_kind IN ('succeeded','failed','cancelled') AND provider_latency_ms IS NOT NULL)::text AS p95_provider_latency_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY total_latency_ms)
    FILTER (WHERE event_kind IN ('succeeded','failed','cancelled') AND total_latency_ms IS NOT NULL)::text AS p50_total_latency_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY total_latency_ms)
    FILTER (WHERE event_kind IN ('succeeded','failed','cancelled') AND total_latency_ms IS NOT NULL)::text AS p95_total_latency_ms`;

function unifiedMetrics(row?: UnifiedAggregateRow) {
  const latency = (value: string | number | null | undefined) => value === null || value === undefined
    ? null
    : Math.max(0,Math.round(Number(value)));
  return {
    requestCount: count(row?.request_count ?? 0),
    attemptedCount: count(row?.attempted_count ?? 0),
    succeededCount: count(row?.succeeded_count ?? 0),
    failedCount: count(row?.failed_count ?? 0),
    cancelledCount: count(row?.cancelled_count ?? 0),
    processingCount: count(row?.processing_count ?? 0),
    fallbackAttemptCount: count(row?.fallback_attempt_count ?? 0),
    inputTokens: exactInteger(row?.input_tokens ?? 0),
    outputTokens: exactInteger(row?.output_tokens ?? 0),
    cachedInputTokens: exactInteger(row?.cached_input_tokens ?? 0),
    reasoningTokens: exactInteger(row?.reasoning_tokens ?? 0),
    settledCredits: exactInteger(row?.settled_credits ?? 0),
    unpricedCount: count(row?.unpriced_count ?? 0),
    latencyMs: {
      queueP50: latency(row?.p50_queue_latency_ms),
      queueP95: latency(row?.p95_queue_latency_ms),
      providerP50: latency(row?.p50_provider_latency_ms),
      providerP95: latency(row?.p95_provider_latency_ms),
      totalP50: latency(row?.p50_total_latency_ms),
      totalP95: latency(row?.p95_total_latency_ms),
    },
  };
}

function normalizeExactDecimal(value: unknown) {
  const text = String(value ?? "0");
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error("INVALID_AI_USAGE_DECIMAL");
  return text.replace(/(\.\d*?)0+$/,"$1").replace(/\.$/,"").replace(/^0+(?=\d)/,"") || "0";
}

async function readUnifiedAiUsage(
  queryable: Queryable,period: MaintenanceAiUsagePeriod,includeProbeTraffic: boolean,
) {
  const values = [period.from,period.to,includeProbeTraffic];
  const grouped = (dimension: string,selection: string,grouping: string,filter = "true") => `
    (SELECT '${dimension}'::text AS dimension_key,${selection},${unifiedMetricColumns}
     FROM filtered WHERE ${filter} GROUP BY ${grouping} ORDER BY COUNT(*) DESC LIMIT ${DIMENSION_LIMIT + 1})`;
  const result = await queryable.query<UnifiedAggregateRow>(`/* maintenance-ai-usage:unified */
    WITH filtered AS MATERIALIZED (
      SELECT usage_day,consumer,role,event_kind,deployment_revision_id,model_id,fallback_rank,
        input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,queue_latency_ms,provider_latency_ms,
        total_latency_ms,provider_cost_amount,provider_cost_currency,platform_settled_credits,
        pricing_state,error_class,occurred_at
      FROM maintenance_ai_usage_events_v2_safe
      WHERE occurred_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
        AND occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND ($3::boolean OR consumer<>'probe')
    )
    (SELECT 'summary'::text AS dimension_key,NULL::text AS group_key,NULL::text AS group_label,
      ${unifiedMetricColumns} FROM filtered)
    UNION ALL ${grouped("day","usage_day::text AS group_key,NULL::text AS group_label","usage_day")}
    UNION ALL ${grouped("consumer","consumer AS group_key,NULL::text AS group_label","consumer")}
    UNION ALL ${grouped("role","COALESCE(role,'unassigned') AS group_key,NULL::text AS group_label","COALESCE(role,'unassigned')")}
    UNION ALL ${grouped("model","COALESCE(deployment_revision_id,'unassigned') AS group_key,MAX(model_id) AS group_label","COALESCE(deployment_revision_id,'unassigned')")}
    UNION ALL ${grouped("error","error_class AS group_key,NULL::text AS group_label","error_class","error_class IS NOT NULL")}
  `,values);
  const rows = (dimension: string) => result.rows.filter(row => row.dimension_key===dimension);
  const group = (dimension: string) => {
    const values = rows(dimension).map(row => ({
      key: String(row.group_key),...(row.group_label ? { label: row.group_label } : {}),...unifiedMetrics(row),
    }));
    return { data: values.slice(0,DIMENSION_LIMIT),truncated: values.length>DIMENSION_LIMIT };
  };
  const dayMap = new Map(rows("day").map(row => [String(row.group_key),unifiedMetrics(row)]));
  const [costs,alerts] = await Promise.all([
    queryable.query<{ currency: string;amount: string }>(`/* maintenance-ai-usage:provider-cost */
      SELECT provider_cost_currency AS currency,COALESCE(SUM(provider_cost_amount),0)::text AS amount
      FROM maintenance_ai_usage_events_v2_safe
      WHERE occurred_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
        AND occurred_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND ($3::boolean OR consumer<>'probe') AND provider_cost_currency IS NOT NULL
      GROUP BY provider_cost_currency ORDER BY provider_cost_currency
    `,values),
    queryable.query<{
      id: string;budget_policy_id: string;scope_kind: string;scope_key: string;period: string;
      unit: string;limit_amount: string;period_start: Date;threshold_percent: number;
      observed_amount: string;status: string;created_at: Date;
    }>(`/* maintenance-ai-usage:budget-alerts */
      SELECT id,budget_policy_id,scope_kind,scope_key,period,unit,limit_amount::text,
        period_start,threshold_percent,observed_amount::text,status,created_at
      FROM maintenance_ai_budget_alerts_safe
      WHERE period_start < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND created_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
      ORDER BY created_at DESC,id LIMIT 100
    `,values.slice(0,2)),
  ]);
  return {
    includeProbeTraffic,
    population: "gateway_invocation_events" as const,
    summary: unifiedMetrics(rows("summary")[0]),
    byDay: daysInPeriod(period).map(key => ({ key,...(dayMap.get(key) ?? unifiedMetrics()) })),
    byConsumer: group("consumer"),byRole: group("role"),byModel: group("model"),byError: group("error"),
    providerCosts: costs.rows.map(row => ({ currency: row.currency,amount: normalizeExactDecimal(row.amount) })),
    budgetAlerts: alerts.rows.map(row => ({
      id: row.id,budgetPolicyId: row.budget_policy_id,scope: row.scope_kind,scopeId: row.scope_key,
      period: row.period,unit: row.unit,limit: normalizeExactDecimal(row.limit_amount),
      periodStart: row.period_start.toISOString(),thresholdPercentage: row.threshold_percent,
      observed: normalizeExactDecimal(row.observed_amount),status: row.status,createdAt: row.created_at.toISOString(),
    })),
  };
}

async function withConsistentRead<T>(database: SnapshotDatabase, operation: (queryable: Queryable) => Promise<T>) {
  if (typeof database.connect !== "function") return operation(database);
  const client = await database.connect() as PoolClient;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='5s'");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadMaintenanceAiUsage(
  database: SnapshotDatabase,
  period: MaintenanceAiUsagePeriod,
  options: { includeUnified?: boolean;includeProbeTraffic?: boolean } = {},
) {
  return withConsistentRead(database,async (queryable) => {
    const legacy = await readMaintenanceAiUsage(queryable,period);
    if (!options.includeUnified) return legacy;
    return {
      ...legacy,
      unified: await readUnifiedAiUsage(queryable,period,options.includeProbeTraffic === true),
    };
  });
}
