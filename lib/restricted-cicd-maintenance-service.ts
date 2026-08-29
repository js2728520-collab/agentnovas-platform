import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { ResearchApiError } from "./research-errors.ts";

type Json = Record<string, unknown>;
type TransactionSource = Pool | PoolClient;

const ENVIRONMENTS = new Set(["staging", "production"]);
const ACTIONS = new Set(["deploy", "rollback"]);

function exactObject(value: unknown, keys: string[], label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) {
    throw new ResearchApiError("VALIDATION_ERROR", `${label} 字段不完整或包含未知字段`, 422);
  }
  return value as Json;
}

function text(body: Json, key: string, minimum = 1, maximum = 500) {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (value.length < minimum || value.length > maximum) throw new ResearchApiError("VALIDATION_ERROR", `${key} 无效`, 422, { fields: [key] });
  return value;
}

function choice<T extends string>(body: Json, key: string, allowed: ReadonlySet<T>) {
  const value = text(body, key) as T;
  if (!allowed.has(value)) throw new ResearchApiError("VALIDATION_ERROR", `${key} 无效`, 422, { fields: [key] });
  return value;
}

function expiry(body: Json, key = "expiresAt") {
  const value = new Date(text(body, key, 20, 40));
  if (!Number.isFinite(value.getTime()) || value <= new Date() || value.getTime() > Date.now() + 24 * 60 * 60_000) {
    throw new ResearchApiError("VALIDATION_ERROR", `${key} 必须在未来 24 小时内`, 422, { fields: [key] });
  }
  return value;
}

function reason(body: Json) { return text(body, "reason", 8, 500); }

function factId(prefix: string, actorUserId: string, idempotencyKey: string) {
  return `${prefix}-${createHash("sha256").update(`${actorUserId}\0${prefix}\0${idempotencyKey}`).digest("hex").slice(0, 48)}`;
}

function mapDatabaseError(error: unknown): never {
  const candidate = error as { code?: string; message?: string };
  const code = candidate?.code;
  if (code === "23505") throw new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键或既有决策与本次请求不一致", 409);
  if (code === "42501") throw new ResearchApiError("SEPARATION_OF_DUTIES_REQUIRED", "当前人员不满足独立审批要求", 403);
  if (code === "P0002") throw new ResearchApiError("RELEASE_WORKFLOW_FACT_NOT_FOUND", "受限发布工作流事实不存在", 404);
  if (code === "40001" || code === "55000") throw new ResearchApiError("RELEASE_WORKFLOW_NOT_READY", "环境状态或前置证据尚不允许该操作", 409);
  if (code === "22023" || code === "23514") throw new ResearchApiError("VALIDATION_ERROR", "受限发布绑定无效", 422);
  throw error;
}

async function transaction<T>(source: TransactionSource, operation: (client: PoolClient) => Promise<T>) {
  if ("release" in source) return operation(source as PoolClient);
  const client = await (source as Pool).connect() as PoolClient;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export async function readRestrictedCicdMaintenance(pool: Pool, limit = 50) {
  try {
    const result = await pool.query<{ payload: Json }>("SELECT release_workflow_read_maintenance_control($1) AS payload", [limit]);
    return result.rows[0]?.payload ?? { environments: [], commands: [], commandRequests: [], activationRequests: [], stopReleases: [], stops: [] };
  } catch (error) { mapDatabaseError(error); }
}

export async function requestRestrictedCicdActivation(pool: TransactionSource, input: {
  actorUserId: string; sessionSecret: string; idempotencyKey: string; requestId: string; body: unknown;
}) {
  const body = exactObject(input.body, ["releaseVersionId", "environment", "reason", "expiresAt"], "activation");
  const id = factId("activation-request", input.actorUserId, input.idempotencyKey);
  const values = [id, text(body, "releaseVersionId", 3, 160), choice(body, "environment", ENVIRONMENTS), input.sessionSecret, reason(body), input.idempotencyKey, input.requestId, expiry(body)];
  return transaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM release_workflow_request_activation_v2($1,$2,$3,$4,$5,$6,$7,$8)", values);
    return result.rows[0];
  });
}

export async function reviewRestrictedCicdActivation(pool: TransactionSource, input: {
  activationRequestId: string; actorUserId: string; sessionSecret: string; idempotencyKey: string; requestId: string; body: unknown;
}) {
  const body = exactObject(input.body, ["approvalKind", "decision", "reason"], "activation review");
  const resultValues = [factId("activation-review", input.actorUserId, input.idempotencyKey), input.activationRequestId, input.sessionSecret,
    choice(body, "approvalKind", new Set(["security", "release"])),
    choice(body, "decision", new Set(["approve", "reject"])), reason(body), input.requestId];
  return transaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM release_workflow_review_activation_v2($1,$2,$3,$4,$5,$6,$7)", resultValues);
    return result.rows[0];
  });
}

export async function enableFirstProduction(pool: TransactionSource, input: {
  activationId: string; actorUserId: string; sessionSecret: string; idempotencyKey: string; requestId: string; body: unknown;
}) {
  const body = exactObject(input.body, ["reason", "expiresAt"], "production enablement");
  const values = [factId("production-enablement", input.actorUserId, input.idempotencyKey), input.activationId, input.sessionSecret, reason(body), input.requestId, expiry(body)];
  return transaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM release_workflow_enable_first_production_v2($1,$2,$3,$4,$5,$6)", values);
    return result.rows[0];
  });
}

export async function requestRestrictedCicdCommand(pool: TransactionSource, input: {
  releaseVersionId: string; environment: "staging" | "production"; actorUserId: string; sessionSecret: string; idempotencyKey: string; requestId: string; body: unknown;
}) {
  const body = exactObject(input.body, ["environment", "action", "reason"], "command request");
  const bodyEnvironment = choice(body, "environment", ENVIRONMENTS);
  if (bodyEnvironment !== input.environment) throw new ResearchApiError("VALIDATION_ERROR", "environment 与路由不一致", 422);
  const values = [factId("command-request", input.actorUserId, input.idempotencyKey), text({ releaseVersionId: input.releaseVersionId }, "releaseVersionId", 3, 160), bodyEnvironment, choice(body, "action", ACTIONS), input.sessionSecret, reason(body), input.idempotencyKey, input.requestId];
  return transaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM release_workflow_request_command_v2($1,$2,$3,$4,$5,$6,$7,$8)", values);
    return result.rows[0];
  });
}

export async function reviewRestrictedCicdCommand(pool: TransactionSource, input: {
  commandRequestId: string; environment: "staging" | "production"; actorUserId: string; sessionSecret: string; idempotencyKey: string; requestId: string; body: unknown;
}) {
  const body = exactObject(input.body, ["decision", "reason", "expiresAt"], "command review");
  const values = [factId("command-review", input.actorUserId, input.idempotencyKey), input.commandRequestId, input.environment, input.sessionSecret, choice(body, "decision", new Set(["approve", "reject"])), reason(body), input.requestId, expiry(body)];
  return transaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM release_workflow_review_command_v2($1,$2,$3,$4,$5,$6,$7,$8)", values);
    return result.rows[0];
  });
}

export async function requestRestrictedCicdStop(pool: TransactionSource, input: { environment: string; actorUserId: string; sessionSecret: string; idempotencyKey: string; requestId: string; body: unknown }) {
  const body = exactObject(input.body, ["reason"], "stop request");
  const values = [factId("stop-request", input.actorUserId, input.idempotencyKey), choice({ environment: input.environment }, "environment", ENVIRONMENTS), input.sessionSecret, reason(body), input.requestId];
  return transaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM release_workflow_request_stop_v2($1,$2,$3,$4,$5)", values);
    return result.rows[0];
  });
}

export async function requestRestrictedCicdStopRelease(pool: TransactionSource, input: { actorUserId: string; sessionSecret: string; idempotencyKey: string; requestId: string; body: unknown }) {
  const body = exactObject(input.body, ["environment", "activationId", "reason"], "stop release request");
  const values = [factId("stop-release-request", input.actorUserId, input.idempotencyKey), choice(body, "environment", ENVIRONMENTS), text(body, "activationId", 3, 160), input.sessionSecret, reason(body), input.idempotencyKey, input.requestId];
  return transaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM release_workflow_request_stop_release_v2($1,$2,$3,$4,$5,$6,$7)", values);
    return result.rows[0];
  });
}

export async function reviewRestrictedCicdStopRelease(pool: TransactionSource, input: { stopReleaseRequestId: string; actorUserId: string; sessionSecret: string; idempotencyKey: string; requestId: string; body: unknown }) {
  const body = exactObject(input.body, ["reason"], "stop release review");
  const values = [factId("stop-release-review", input.actorUserId, input.idempotencyKey), input.stopReleaseRequestId, input.sessionSecret, reason(body), input.requestId];
  return transaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM release_workflow_review_stop_release_v2($1,$2,$3,$4,$5)", values);
    return result.rows[0];
  });
}
