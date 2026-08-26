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

export async function loadMaintenanceAiUsage(database: SnapshotDatabase, period: MaintenanceAiUsagePeriod) {
  return withConsistentRead(database, (queryable) => readMaintenanceAiUsage(queryable, period));
}
