import { createServer } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

import {
  RestrictedCicdIngressError,
  createRestrictedCicdIngressDatabase,
  loadRestrictedCicdWebhookSecret,
  parseRestrictedCicdIngressBinding,
  processRestrictedCicdGithubWebhook,
} from "../lib/restricted-cicd-ingress.ts";

if (process.env.RELEASE_WEBHOOK_INGRESS_ENABLED !== "true") {
  throw new Error("RELEASE_WEBHOOK_INGRESS_ENABLED must be true");
}

const databaseValue = process.env.RELEASE_WEBHOOK_DATABASE_URL?.trim();
if (!databaseValue) throw new Error("RELEASE_WEBHOOK_DATABASE_URL is required");
const databaseUrl = new URL(databaseValue);
if (!(databaseUrl.protocol === "postgres:" || databaseUrl.protocol === "postgresql:")
  || databaseUrl.username !== "agentnovas_release_ingress") {
  throw new Error("RELEASE_WEBHOOK_DATABASE_URL must use the dedicated release ingress role");
}

const bindingFile = process.env.RELEASE_WEBHOOK_BINDING_FILE?.trim() ?? "";
if (!path.isAbsolute(bindingFile) || bindingFile.length > 500 || bindingFile.includes("\0")) {
  throw new Error("RELEASE_WEBHOOK_BINDING_FILE must be an absolute path");
}

async function loadBinding(filePath) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 16 * 1024
      || (metadata.mode & 0o022) !== 0) throw new Error("binding custody");
    return parseRestrictedCicdIngressBinding(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    throw new Error("restricted CI/CD ingress binding unavailable");
  }
}

function boundedPort(value) {
  const parsed = Number(value ?? 3004);
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : 3004;
}

function safeCode(error) {
  if (error instanceof RestrictedCicdIngressError) return error.code;
  return "RELEASE_WEBHOOK_REQUEST_FAILED";
}

const loadedBinding = await loadBinding(bindingFile);
const webhookSecretOverride = process.env.RELEASE_WEBHOOK_SECRET_FILE?.trim();
if (webhookSecretOverride && (!path.isAbsolute(webhookSecretOverride)
  || webhookSecretOverride.length > 500 || webhookSecretOverride.includes("\0"))) {
  throw new Error("RELEASE_WEBHOOK_SECRET_FILE must be an absolute path");
}
const binding = webhookSecretOverride
  ? { ...loadedBinding, webhookSecretFile: webhookSecretOverride }
  : loadedBinding;
const webhookSecret = await loadRestrictedCicdWebhookSecret(binding.webhookSecretFile);
const pool = new pg.Pool({
  connectionString: databaseUrl.toString(),
  max: 4,
  application_name: "agentnovas-release-webhook-ingress",
});
const database = createRestrictedCicdIngressDatabase(pool);
const port = boundedPort(process.env.RELEASE_WEBHOOK_PORT);
const host = process.env.RELEASE_WEBHOOK_HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";

function singleHeader(value) {
  return typeof value === "string" ? value : undefined;
}

function respond(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.url !== "/internal/release-webhook/github") {
    request.resume();
    respond(response, 404, { error: "not_found" });
    return;
  }
  if (request.method !== "POST") {
    request.resume();
    respond(response, 405, { error: "method_not_allowed" });
    return;
  }
  const declaredLength = Number(singleHeader(request.headers["content-length"]));
  if (!Number.isInteger(declaredLength) || declaredLength < 2 || declaredLength > 256 * 1024) {
    request.resume();
    respond(response, 413, { error: "payload_rejected" });
    return;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > 256 * 1024) throw new RestrictedCicdIngressError(
        "WEBHOOK_PAYLOAD_REJECTED",
        "GitHub webhook payload rejected",
      );
      chunks.push(bytes);
    }
    const rawBody = Buffer.concat(chunks, size);
    if (rawBody.byteLength !== declaredLength) throw new RestrictedCicdIngressError(
      "WEBHOOK_PAYLOAD_REJECTED",
      "GitHub webhook payload rejected",
    );
    const result = await processRestrictedCicdGithubWebhook({
      binding,
      webhookSecret,
      database,
      rawBody,
      headers: {
        "content-type": singleHeader(request.headers["content-type"]),
        "user-agent": singleHeader(request.headers["user-agent"]),
        "x-github-event": singleHeader(request.headers["x-github-event"]),
        "x-github-delivery": singleHeader(request.headers["x-github-delivery"]),
        "x-github-hook-installation-target-type": singleHeader(
          request.headers["x-github-hook-installation-target-type"],
        ),
        "x-github-hook-installation-target-id": singleHeader(
          request.headers["x-github-hook-installation-target-id"],
        ),
        "x-hub-signature-256": singleHeader(request.headers["x-hub-signature-256"]),
      },
    });
    respond(response, 202, { accepted: result.accepted });
  } catch (error) {
    const statusCode = error instanceof RestrictedCicdIngressError
      ? error.code === "WEBHOOK_UNAUTHORIZED" ? 401 : 422
      : 503;
    console.error("Release webhook request failed", { code: safeCode(error) });
    respond(response, statusCode, { error: statusCode === 401 ? "unauthorized" : "request_rejected" });
  }
});

server.requestTimeout = 8_000;
server.headersTimeout = 9_000;
server.keepAliveTimeout = 5_000;

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => pool.end().finally(() => process.exit(0)));
  });
}

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ event: "release_webhook_ingress_started", host, port, enabled: true })}\n`);
});
