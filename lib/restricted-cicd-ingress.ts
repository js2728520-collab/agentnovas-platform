import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;
type HeaderMap = Record<string, string | undefined>;
type QueryResult = { rows: Array<Record<string, unknown>> };
type Queryable = { query: (text: string, values?: unknown[]) => Promise<QueryResult> };

const BINDING_KEYS = [
  "provider", "repositoryOwner", "repositoryName", "repositoryId", "workflowId", "workflowPath",
  "workflowControlRef", "controlCommitSha", "webhookSecretFile",
] as const;
const MAX_WEBHOOK_BYTES = 256 * 1024;

export type RestrictedCicdIngressBinding = {
  provider: "github_actions";
  repositoryOwner: string;
  repositoryName: string;
  repositoryId: string;
  workflowId: string;
  workflowPath: string;
  workflowControlRef: string;
  controlCommitSha: string;
  webhookSecretFile: string;
};

export type RestrictedCicdDelivery = {
  deliveryId: string;
  eventName: "workflow_run";
  action: "requested" | "in_progress" | "completed";
  repositoryId: string;
  workflowId: string;
  runId: string;
  runAttempt: 1;
  headSha: string;
  headRef: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | "unknown" | null;
  bodySha256: string;
  payloadSizeBytes: number;
};

export type RestrictedCicdIngressDatabase = {
  appendDelivery(delivery: RestrictedCicdDelivery): Promise<{ replayed: boolean }>;
};

export class RestrictedCicdIngressError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RestrictedCicdIngressError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RestrictedCicdIngressError(code, message);
}

function isObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: JsonObject, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

function numberMatches(value: unknown, expected: string) {
  return (typeof value === "number" && Number.isSafeInteger(value) && String(value) === expected)
    || value === expected;
}

function repoPart(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 100
    && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

export function parseRestrictedCicdIngressBinding(input: unknown): RestrictedCicdIngressBinding {
  if (!isObject(input) || !exactKeys(input, BINDING_KEYS)
    || input.provider !== "github_actions"
    || !repoPart(input.repositoryOwner)
    || !repoPart(input.repositoryName)
    || !positiveId(input.repositoryId)
    || !positiveId(input.workflowId)
    || typeof input.workflowPath !== "string"
    || !/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.ya?ml$/.test(input.workflowPath)
    || typeof input.workflowControlRef !== "string"
    || !/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]{0,198}$/.test(input.workflowControlRef)
    || typeof input.controlCommitSha !== "string"
    || !/^[a-f0-9]{40}$/.test(input.controlCommitSha)
    || typeof input.webhookSecretFile !== "string"
    || !path.isAbsolute(input.webhookSecretFile)
    || input.webhookSecretFile.length > 500
    || input.webhookSecretFile.includes("\0")) {
    return fail("INGRESS_BINDING_INVALID", "Restricted CI/CD ingress binding invalid");
  }
  return input as RestrictedCicdIngressBinding;
}

export async function loadRestrictedCicdWebhookSecret(filePath: string) {
  try {
    if (!path.isAbsolute(filePath) || filePath.length > 500 || filePath.includes("\0")) throw new Error("path");
    const metadata = await lstat(filePath);
    const permissions = metadata.mode & 0o7777;
    if (!metadata.isFile() || metadata.isSymbolicLink() || (permissions & 0o7337) !== 0) throw new Error("custody");
    if (metadata.size < 32 || metadata.size > 1_024) throw new Error("size");
    const secret = await readFile(filePath);
    if (secret.includes(0) || secret.includes(10) || secret.includes(13)) throw new Error("format");
    return secret;
  } catch {
    return fail("WEBHOOK_SECRET_UNAVAILABLE", "Restricted CI/CD webhook secret unavailable");
  }
}

export function verifyRestrictedCicdWebhookSignature(
  secret: Buffer,
  rawBody: Buffer,
  signatureHeader: string | undefined,
) {
  if (!Buffer.isBuffer(secret) || secret.byteLength < 1 || !Buffer.isBuffer(rawBody)
    || typeof signatureHeader !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signatureHeader)) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`, "ascii");
  const actual = Buffer.from(signatureHeader, "ascii");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function requiredObject(value: unknown) {
  return isObject(value) ? value : fail("WEBHOOK_PAYLOAD_REJECTED", "GitHub webhook payload rejected");
}

function normalizeConclusion(value: unknown, completed: boolean): RestrictedCicdDelivery["conclusion"] {
  if (!completed) return value === null ? null : fail("WEBHOOK_PAYLOAD_REJECTED", "GitHub webhook payload rejected");
  if (value === "success" || value === "failure" || value === "cancelled" || value === "timed_out") return value;
  return typeof value === "string" && value.length > 0 ? "unknown" : fail(
    "WEBHOOK_PAYLOAD_REJECTED",
    "GitHub webhook payload rejected",
  );
}

function parseDelivery(
  binding: RestrictedCicdIngressBinding,
  headers: HeaderMap,
  rawBody: Buffer,
): RestrictedCicdDelivery {
  const deliveryId = headers["x-github-delivery"];
  const eventName = headers["x-github-event"];
  const targetType = headers["x-github-hook-installation-target-type"];
  const targetId = headers["x-github-hook-installation-target-id"];
  const mediaType = headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (rawBody.byteLength < 2 || rawBody.byteLength > MAX_WEBHOOK_BYTES
    || mediaType !== "application/json"
    || !headers["user-agent"]?.startsWith("GitHub-Hookshot/")
    || eventName !== "workflow_run"
    || typeof deliveryId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deliveryId)
    || targetType !== "repository"
    || targetId !== binding.repositoryId) {
    return fail("WEBHOOK_PAYLOAD_REJECTED", "GitHub webhook payload rejected");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return fail("WEBHOOK_PAYLOAD_REJECTED", "GitHub webhook payload rejected");
  }
  const payload = requiredObject(parsed);
  const repository = requiredObject(payload.repository);
  const owner = requiredObject(repository.owner);
  const run = requiredObject(payload.workflow_run);
  const action = payload.action;
  const tagName = binding.workflowControlRef.slice("refs/tags/".length);
  const status = run.status;
  if ((action !== "requested" && action !== "in_progress" && action !== "completed")
    || !numberMatches(repository.id, binding.repositoryId)
    || repository.full_name !== `${binding.repositoryOwner}/${binding.repositoryName}`
    || owner.login !== binding.repositoryOwner
    || !numberMatches(run.workflow_id, binding.workflowId)
    || typeof run.id !== "number" || !Number.isSafeInteger(run.id) || run.id < 1
    || run.run_attempt !== 1
    || run.event !== "workflow_dispatch"
    || run.path !== `${binding.workflowPath}@${tagName}`
    || run.head_sha !== binding.controlCommitSha
    || run.head_branch !== tagName
    || (status !== "queued" && status !== "in_progress" && status !== "completed")
    || (action === "requested" && status !== "queued")
    || (action === "in_progress" && status !== "in_progress")
    || (action === "completed" && status !== "completed")) {
    return fail("WEBHOOK_PAYLOAD_REJECTED", "GitHub webhook payload rejected");
  }
  return {
    deliveryId,
    eventName,
    action,
    repositoryId: binding.repositoryId,
    workflowId: binding.workflowId,
    runId: String(run.id),
    runAttempt: 1,
    headSha: binding.controlCommitSha,
    headRef: tagName,
    status,
    conclusion: normalizeConclusion(run.conclusion, action === "completed"),
    bodySha256: createHash("sha256").update(rawBody).digest("hex"),
    payloadSizeBytes: rawBody.byteLength,
  };
}

export function createRestrictedCicdIngressDatabase(queryable: Queryable): RestrictedCicdIngressDatabase {
  return {
    async appendDelivery(delivery) {
      const result = await queryable.query(`
        SELECT * FROM release_workflow_append_delivery(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
        )
      `, [
        delivery.deliveryId, delivery.eventName, delivery.action, delivery.repositoryId,
        delivery.workflowId, delivery.runId, delivery.runAttempt, delivery.headSha,
        delivery.headRef, delivery.status, delivery.conclusion, delivery.bodySha256,
        delivery.payloadSizeBytes,
      ]);
      if (result.rows.length !== 1 || typeof result.rows[0].replayed !== "boolean") {
        throw new Error("delivery gateway response invalid");
      }
      return { replayed: result.rows[0].replayed };
    },
  };
}

export async function processRestrictedCicdGithubWebhook(input: {
  binding: RestrictedCicdIngressBinding;
  webhookSecret: Buffer;
  database: RestrictedCicdIngressDatabase;
  headers: HeaderMap;
  rawBody: Buffer;
}) {
  if (!verifyRestrictedCicdWebhookSignature(
    input.webhookSecret,
    input.rawBody,
    input.headers["x-hub-signature-256"],
  )) {
    return fail("WEBHOOK_UNAUTHORIZED", "GitHub webhook unauthorized");
  }
  const delivery = parseDelivery(input.binding, input.headers, input.rawBody);
  const result = await input.database.appendDelivery(delivery);
  return { accepted: true as const, replayed: result.replayed };
}
