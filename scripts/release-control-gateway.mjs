import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { getReleaseControlPostgresPool } from "../lib/postgres.ts";
import {
  parseRestrictedCicdHumanActionEnvelope,
  restrictedCicdHumanActionMutationDocument,
  restrictedCicdHumanActionMutationSha256,
} from "../lib/restricted-cicd-human-action.ts";
import { ResearchApiError } from "../lib/research-errors.ts";

if (process.env.RELEASE_CONTROL_ENABLED !== "true") throw new Error("Restricted release control is disabled");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numericPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("RELEASE_CONTROL_PORT invalid");
  return port;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new Error(`${label} invalid`);
  return value;
}

function textValue(value, minimum, maximum, label) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${label} invalid`);
  return value;
}

function receiveBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 96 * 1024) { reject(new Error("body limit")); request.destroy(); }
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function respond(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function authorized(header, expected) {
  const supplied = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(supplied); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function mapDatabaseError(error) {
  const code = error?.code;
  if (code === "23505") return new ResearchApiError("IDEMPOTENCY_PAYLOAD_MISMATCH", "幂等键或既有决策与本次请求不一致", 409);
  if (code === "42501") return new ResearchApiError("HUMAN_ACTION_REQUIRED", "本次精确动作缺少有效且未消费的人类签名", 403);
  if (code === "P0002") return new ResearchApiError("RELEASE_WORKFLOW_FACT_NOT_FOUND", "受限发布工作流事实不存在", 404);
  if (code === "40001" || code === "55000") return new ResearchApiError("RELEASE_WORKFLOW_NOT_READY", "环境状态或前置证据尚不允许该操作", 409);
  if (code === "22023" || code === "23514") return new ResearchApiError("VALIDATION_ERROR", "受限发布动作绑定无效", 422);
  return error;
}

const host = process.env.RELEASE_CONTROL_HOST?.trim() || "127.0.0.1";
if (!new Set(["127.0.0.1", "0.0.0.0"]).has(host)) throw new Error("RELEASE_CONTROL_HOST invalid");
const port = numericPort(process.env.RELEASE_CONTROL_PORT?.trim() || "3314");
const sharedSecret = required("RELEASE_CONTROL_GATEWAY_SHARED_SECRET");
if (sharedSecret.length < 32 || sharedSecret.length > 512) throw new Error("RELEASE_CONTROL_GATEWAY_SHARED_SECRET invalid");
const pool = await getReleaseControlPostgresPool();

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return respond(response, 200, { ok: true, enabled: true });
    if (request.method !== "POST" || request.url !== "/v1/mutations") return respond(response, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
    if (!authorized(request.headers.authorization, sharedSecret)) return respond(response, 403, { error: { code: "FORBIDDEN", message: "Release control caller rejected" } });
    const requestBody = exactObject(JSON.parse(await receiveBody(request)), ["schemaVersion", "assertionId", "mutationSha256", "envelope"], "Release control request");
    if (requestBody.schemaVersion !== "1") throw new Error("Release control schema invalid");
    const assertionId = textValue(requestBody.assertionId, 3, 160, "Release control assertion ID");
    const suppliedDigest = textValue(requestBody.mutationSha256, 64, 64, "Release control mutation digest");
    const envelope = parseRestrictedCicdHumanActionEnvelope(requestBody.envelope);
    const computedDigest = restrictedCicdHumanActionMutationSha256(envelope);
    if (suppliedDigest !== computedDigest) throw new Error("Release control mutation digest mismatch");
    const result = await pool.query("SELECT release_workflow_execute_human_action($1,$2,$3,$4) AS result", [
      assertionId, envelope.sessionSecret, restrictedCicdHumanActionMutationDocument(envelope), suppliedDigest,
    ]).catch((error) => { throw mapDatabaseError(error); });
    return respond(response, 200, { result: result.rows[0]?.result });
  } catch (error) {
    if (error instanceof ResearchApiError) return respond(response, error.status, { error: { code: error.code, message: error.message, details: error.details } });
    return respond(response, 422, { error: { code: "RELEASE_CONTROL_REJECTED", message: "Release control request rejected" } });
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, host);

async function shutdown() { server.close(); await pool.end(); }
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
