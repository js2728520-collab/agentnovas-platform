import type { Pool, PoolClient } from "pg";

import { INTEGRATION_CATALOG, type IntegrationDefinition } from "./integration-catalog.ts";
import { runMaintenanceIdempotentExternalCommand } from "./maintenance-idempotency.ts";

const HEALTH_FRESH_MS = 15 * 60_000;
const SAFE_CHECK_TARGETS: Record<string, { url: string; content: "json-time" | "rss" }> = {
  "binance-public-market": { url: "https://data-api.binance.vision/api/v3/time", content: "json-time" },
  "coindesk-rss": { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", content: "rss" },
  "cointelegraph-rss": { url: "https://cointelegraph.com/rss", content: "rss" },
};

function catalogItem(id: string) {
  return INTEGRATION_CATALOG.find((item) => item.id === id && (item.category === "market" || item.category === "news"));
}

function configurationStatus(item: IntegrationDefinition, environment: Record<string, string | undefined>) {
  if (!item.requiresKey && item.status === "wired") return { configured: true, hasSecret: false };
  const present = item.envKeys.some((key) => Boolean(environment[key]?.trim()));
  return { configured: present, hasSecret: item.requiresKey && present };
}

export async function listMaintenanceSourceIntegrations(pool: Pick<Pool, "query">, environment: Record<string, string | undefined> = process.env, now = new Date()) {
  const latest = await pool.query<{ subject_id: string; after_json: string | Record<string, unknown>; created_at: Date }>(`
    SELECT DISTINCT ON(subject_id) subject_id,after_json,created_at
      FROM audit_logs
     WHERE action='maintenance.integration_test'
     ORDER BY subject_id,created_at DESC,id DESC
  `);
  const latestById = new Map(latest.rows.map((row) => [row.subject_id, row]));
  return INTEGRATION_CATALOG.filter((item) => item.category === "market" || item.category === "news").map((item) => {
    const configuration = configurationStatus(item, environment);
    const missingEnvKeys = item.envKeys.filter((key) => !environment[key]?.trim());
    const check = latestById.get(item.id);
    let result: Record<string, unknown> = {};
    if (check) {
      try { result = typeof check.after_json === "string" ? JSON.parse(check.after_json) : check.after_json; } catch { result = {}; }
    }
    const lastTestAt = check ? new Date(check.created_at).toISOString() : null;
    const age = check ? now.getTime() - new Date(check.created_at).getTime() : Number.POSITIVE_INFINITY;
    const lastTestStatus = result.status === "succeeded" || result.status === "failed" ? result.status : null;
    const health = !configuration.configured ? "unconfigured"
      : !check ? "untested"
        : age > HEALTH_FRESH_MS ? "stale"
          : lastTestStatus === "succeeded" ? "healthy" : "degraded";
    return {
      id: item.id,
      category: item.category,
      name: item.name,
      description: item.description,
      implementationStatus: item.status,
      configured: configuration.configured,
      hasSecret: configuration.hasSecret,
      configurationEnvKeys: item.envKeys,
      missingEnvKeys,
      configurationMethod: item.serverOnly ? "server_environment" : "none",
      enabled: item.status === "wired" && configuration.configured,
      health,
      lastTestStatus,
      lastErrorCode: typeof result.errorCode === "string" ? result.errorCode : null,
      lastLatencyMs: Number.isFinite(result.latencyMs) ? Number(result.latencyMs) : null,
      lastTestAt,
      testAvailable: Boolean(SAFE_CHECK_TARGETS[item.id]),
    };
  });
}

export async function runMaintenanceSourceIntegrationCheck(pool: Pick<Pool, "query">, input: {
  id: string;
  actorUserId: string;
  reason: string;
  requestId?: string | null;
  traceId?: string | null;
  fetchImplementation?: typeof fetch;
  now?: Date;
}) {
  const validated = validatedCheckInput(input.id, input.reason);
  const result = await performSourceIntegrationCheck(validated, input.fetchImplementation, input.now);
  await writeSourceIntegrationAudit(pool, input, result);
  return result;
}

function validatedCheckInput(id: string, rawReason: string) {
  const item = catalogItem(id);
  const target = SAFE_CHECK_TARGETS[id];
  const reason = rawReason.trim();
  if (!item) throw new Error("INTEGRATION_NOT_FOUND");
  if (!target) throw new Error("INTEGRATION_TEST_UNAVAILABLE");
  if (reason.length < 3 || reason.length > 500) throw new Error("INTEGRATION_REASON_INVALID");
  return { item, target, reason };
}

async function performSourceIntegrationCheck(
  input: ReturnType<typeof validatedCheckInput>,
  fetchImplementation: typeof fetch = fetch,
  now?: Date,
) {
  const started = performance.now();
  let status: "succeeded" | "failed" = "failed";
  let errorCode: string | null = null;
  try {
    const response = await fetchImplementation(input.target.url, {
      headers: { accept: input.target.content === "rss" ? "application/rss+xml, application/xml, text/xml" : "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    if (input.target.content === "json-time") {
      const payload = await response.json() as { serverTime?: unknown };
      if (!Number.isFinite(payload.serverTime)) throw new Error("INVALID_RESPONSE");
    } else {
      const body = await response.text();
      if (body.length > 2_000_000 || !/<(?:rss|feed)\b/i.test(body) || !/<(?:item|entry)\b/i.test(body)) throw new Error("INVALID_RESPONSE");
    }
    status = "succeeded";
  } catch (error) {
    errorCode = error instanceof Error && /^(?:HTTP_\d{3}|INVALID_RESPONSE)$/.test(error.message) ? error.message : "NETWORK_ERROR";
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  const checkedAt = now ?? new Date();
  return { id: input.item.id, status, errorCode, latencyMs, checkedAt: checkedAt.toISOString() };
}

async function writeSourceIntegrationAudit(
  database: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  input: { actorUserId: string; reason: string; requestId?: string | null; traceId?: string | null },
  result: Awaited<ReturnType<typeof performSourceIntegrationCheck>>,
) {
  await database.query(`
    INSERT INTO audit_logs(id,actor_user_id,action,subject_type,subject_id,after_json,request_id,trace_id,error_code,created_at)
    VALUES($1,$2,'maintenance.integration_test','integration',$3,$4,$5,$6,$7,$8)
  `, [
    crypto.randomUUID(),
    input.actorUserId,
    result.id,
    JSON.stringify({ status: result.status, errorCode: result.errorCode, latencyMs: result.latencyMs, reason: input.reason.trim() }),
    input.requestId ?? null,
    input.traceId ?? null,
    result.errorCode,
    result.checkedAt,
  ]);
}

export async function runIdempotentMaintenanceSourceIntegrationCheck(pool: Pool, input: {
  id: string;
  actorUserId: string;
  reason: string;
  idempotencyKey: string;
  requestId?: string | null;
  traceId?: string | null;
  fetchImplementation?: typeof fetch;
  now?: Date;
}) {
  const validated = validatedCheckInput(input.id, input.reason);
  return runMaintenanceIdempotentExternalCommand(pool, {
    operation: "maintenance.source_integration.test",
    actorUserId: input.actorUserId,
    subjectType: "integration",
    subjectId: validated.item.id,
    idempotencyKey: input.idempotencyKey,
    payload: { id: validated.item.id, reason: validated.reason },
    requestId: input.requestId,
    traceId: input.traceId,
  }, async () => {
    const response = await performSourceIntegrationCheck(validated, input.fetchImplementation, input.now);
    return {
      terminalStatus: response.status,
      responseStatus: response.status === "succeeded" ? 200 : 502,
      response,
      errorCode: response.errorCode,
      finalize: (client: PoolClient) => writeSourceIntegrationAudit(client, input, response),
    };
  });
}
