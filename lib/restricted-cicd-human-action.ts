import { createHash } from "node:crypto";

export type RestrictedCicdControlOperation =
  | "activation.request" | "activation.review" | "production.enable"
  | "command.request" | "command.review" | "stop.request"
  | "stop_release.request" | "stop_release.review";

export type RestrictedCicdHumanActionEnvelope = Readonly<{
  schemaVersion: "1";
  operation: RestrictedCicdControlOperation;
  actorUserId: string;
  sessionSecret: string;
  idempotencyKey: string;
  requestId: string;
  parameters: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
}>;

export type RestrictedCicdHumanActionMutation = Readonly<{
  schemaVersion: "1";
  operation: RestrictedCicdControlOperation;
  actorUserId: string;
  sessionSecretSha256: string;
  idempotencyKey: string;
  requestId: string;
  parameters: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
}>;

const operationPermissions = Object.freeze({
  "activation.request": () => "maint.releases.workflow.activation.request",
  "activation.review": () => "maint.releases.workflow.activation.approve",
  "production.enable": () => "maint.releases.workflow.production.enable",
  "command.request": (parameters: Readonly<Record<string, string>>) => parameters.environment === "staging"
    ? "maint.releases.workflow.stage" : "maint.releases.workflow.production.request",
  "command.review": (parameters: Readonly<Record<string, string>>) => parameters.environment === "staging"
    ? "maint.releases.workflow.stage" : "maint.releases.workflow.production.approve",
  "stop.request": () => "maint.releases.workflow.stop",
  "stop_release.request": () => "maint.releases.workflow.stop.release",
  "stop_release.review": () => "maint.releases.workflow.stop.release",
});

function exactObject(value: unknown, keys: readonly string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) throw new Error(`${label} invalid`);
  return value as Record<string, unknown>;
}

function text(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`${label} invalid`);
  return value;
}

function parseParameters(operation: RestrictedCicdControlOperation, value: unknown) {
  const expected = {
    "activation.request": [], "activation.review": ["activationRequestId"],
    "production.enable": ["activationId"], "command.request": ["releaseVersionId", "environment"],
    "command.review": ["commandRequestId", "environment"], "stop.request": ["environment"],
    "stop_release.request": [], "stop_release.review": ["stopReleaseRequestId"],
  }[operation];
  const parameters = exactObject(value, expected, "Release control parameters");
  for (const key of expected) text(parameters[key], 3, 160, `Release control ${key}`);
  if ("environment" in parameters && !new Set(["staging", "production"]).has(parameters.environment as string)) {
    throw new Error("Release control environment invalid");
  }
  return parameters as Record<string, string>;
}

export function parseRestrictedCicdHumanActionEnvelope(value: unknown): RestrictedCicdHumanActionEnvelope {
  const envelope = exactObject(value, [
    "schemaVersion", "operation", "actorUserId", "sessionSecret", "idempotencyKey",
    "requestId", "parameters", "body",
  ], "Release control envelope");
  if (envelope.schemaVersion !== "1" || typeof envelope.operation !== "string"
    || !Object.hasOwn(operationPermissions, envelope.operation)) throw new Error("Release control envelope invalid");
  const operation = envelope.operation as RestrictedCicdControlOperation;
  const body = envelope.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Release control body invalid");
  return Object.freeze({
    schemaVersion: "1",
    operation,
    actorUserId: text(envelope.actorUserId, 3, 160, "Release control actor"),
    sessionSecret: text(envelope.sessionSecret, 32, 512, "Release control session"),
    idempotencyKey: text(envelope.idempotencyKey, 8, 160, "Release control idempotency key"),
    requestId: text(envelope.requestId, 1, 200, "Release control request ID"),
    parameters: Object.freeze(parseParameters(operation, envelope.parameters)),
    body: Object.freeze(body as Record<string, unknown>),
  });
}

export function restrictedCicdHumanActionPermission(envelope: Pick<RestrictedCicdHumanActionEnvelope, "operation" | "parameters">) {
  return operationPermissions[envelope.operation](envelope.parameters);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Release control canonical input invalid");
}

export function restrictedCicdHumanActionMutationDocument(envelope: RestrictedCicdHumanActionEnvelope) {
  return canonical({
    schemaVersion: "1",
    operation: envelope.operation,
    actorUserId: envelope.actorUserId,
    sessionSecretSha256: createHash("sha256").update(envelope.sessionSecret).digest("hex"),
    idempotencyKey: envelope.idempotencyKey,
    requestId: envelope.requestId,
    parameters: envelope.parameters,
    body: envelope.body,
  });
}

export function parseRestrictedCicdHumanActionMutationDocument(source: unknown): RestrictedCicdHumanActionMutation {
  if (typeof source !== "string" || source.length < 32 || source.length > 32_768) throw new Error("Release mutation document invalid");
  const document = exactObject(JSON.parse(source), [
    "schemaVersion", "operation", "actorUserId", "sessionSecretSha256", "idempotencyKey",
    "requestId", "parameters", "body",
  ], "Release mutation document");
  if (source !== canonical(document) || document.schemaVersion !== "1" || typeof document.operation !== "string"
    || !Object.hasOwn(operationPermissions, document.operation)
    || typeof document.sessionSecretSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(document.sessionSecretSha256)) {
    throw new Error("Release mutation document invalid");
  }
  const operation = document.operation as RestrictedCicdControlOperation;
  if (!document.body || typeof document.body !== "object" || Array.isArray(document.body)) throw new Error("Release mutation body invalid");
  return Object.freeze({
    schemaVersion: "1", operation,
    actorUserId: text(document.actorUserId, 3, 160, "Release mutation actor"),
    sessionSecretSha256: document.sessionSecretSha256,
    idempotencyKey: text(document.idempotencyKey, 8, 160, "Release mutation idempotency key"),
    requestId: text(document.requestId, 1, 200, "Release mutation request ID"),
    parameters: Object.freeze(parseParameters(operation, document.parameters)),
    body: Object.freeze(document.body as Record<string, unknown>),
  });
}

export function restrictedCicdHumanActionMutationSha256(envelope: RestrictedCicdHumanActionEnvelope) {
  return createHash("sha256").update(restrictedCicdHumanActionMutationDocument(envelope)).digest("hex");
}
