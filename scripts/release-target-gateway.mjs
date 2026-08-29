import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { auditRestrictedCicdTargetRun } from "../lib/restricted-cicd-auditor.ts";
import {
  createRestrictedCicdTargetAdapter,
  computeRestrictedCicdTargetBindingSha256,
  parseRestrictedCicdTargetAdapterConfig,
} from "../lib/restricted-cicd-target-adapter.ts";
import {
  executeRestrictedCicdTargetClearAcknowledgement,
  executeRestrictedCicdTargetClearCommit,
  executeRestrictedCicdTargetOperation,
  executeRestrictedCicdTargetStop,
} from "../lib/restricted-cicd-target-engine.ts";
import {
  createRestrictedCicdTargetJournal,
  loadRestrictedCicdReceiptPrivateKey,
  loadRestrictedCicdReceiptTrustPolicy,
  restrictedCicdReceiptPublicKey,
} from "../lib/restricted-cicd-target-journal.ts";
import {
  createRestrictedCicdTargetDatabase,
  fetchRestrictedCicdGithubOidcJwks,
  parseRestrictedCicdTargetClearRequest,
  parseRestrictedCicdTargetStopRequest,
  parseRestrictedCicdWorkflowTargetRequest,
  verifyRestrictedCicdGithubOidcToken,
} from "../lib/restricted-cicd-target.ts";
import { parseRestrictedCicdGithubBinding } from "../lib/restricted-cicd-github.ts";

const enabled = process.env.RELEASE_TARGET_ENABLED === "true";
if (!enabled) throw new Error("Restricted release target is disabled");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readCustodiedJson(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 128 * 1024
    || (metadata.mode & 0o077) !== 0) throw new Error("Target binding custody invalid");
  const body = await readFile(filePath, "utf8");
  return { body, value: JSON.parse(body) };
}

async function readCustodiedPem(filePath, secret) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 64 || metadata.size > 64 * 1024
    || (metadata.mode & (secret ? 0o077 : 0o022)) !== 0) throw new Error("Target TLS custody invalid");
  return readFile(filePath);
}

async function readCustodiedHostIdentity(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 64 || metadata.size > 66
    || (metadata.mode & 0o077) !== 0) throw new Error("Target host identity custody invalid");
  const value = (await readFile(filePath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Target host identity invalid");
  return value;
}

async function readCustodiedSharedSecret(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 32 || metadata.size > 512
    || (metadata.mode & 0o077) !== 0) throw new Error("Target auditor secret custody invalid");
  const value = (await readFile(filePath, "utf8")).trim();
  if (value.length < 32 || value.length > 512) throw new Error("Target auditor secret invalid");
  return value;
}

async function sha256CustodiedFile(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 2 * 1024 * 1024
    || (metadata.mode & 0o022) !== 0) throw new Error("Target executable binding custody invalid");
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function numericPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("RELEASE_TARGET_PORT invalid");
  return port;
}

function parseControlIdentities(value) {
  const keys = Object.keys(value ?? {}).sort().join(",");
  const expected = "breakGlassFingerprintsSha256,schemaVersion,targetFingerprintsSha256";
  if (!value || keys !== expected || value.schemaVersion !== "1"
    || !Array.isArray(value.targetFingerprintsSha256)
    || !Array.isArray(value.breakGlassFingerprintsSha256)) {
    throw new Error("Target control identity binding invalid");
  }
  const parse = (items) => {
    if (items.length < 1 || items.length > 20
      || items.some((item) => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item))
      || new Set(items).size !== items.length) throw new Error("Target control identity binding invalid");
    return new Set(items);
  };
  return {
    target: parse(value.targetFingerprintsSha256),
    breakGlass: parse(value.breakGlassFingerprintsSha256),
  };
}

function receiveBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        reject(new Error("body limit"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function respond(response, status, body) {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

const databaseUrl = required("DATABASE_URL");
const githubBindingFile = required("RELEASE_TARGET_GITHUB_BINDING_FILE");
const adapterConfigFile = required("RELEASE_TARGET_ADAPTER_CONFIG_FILE");
const controlIdentitiesFile = required("RELEASE_TARGET_CONTROL_IDENTITIES_FILE");
const controlTlsKeyFile = required("RELEASE_TARGET_CONTROL_TLS_KEY_FILE");
const controlTlsCertificateFile = required("RELEASE_TARGET_CONTROL_TLS_CERTIFICATE_FILE");
const controlTlsCaFile = required("RELEASE_TARGET_CONTROL_TLS_CA_FILE");
const journalRoot = required("RELEASE_TARGET_JOURNAL_ROOT");
const receiptKeyFile = required("RELEASE_TARGET_RECEIPT_KEY_FILE");
const receiptTrustFile = required("RELEASE_TARGET_RECEIPT_TRUST_FILE");
const hostIdentityFile = required("RELEASE_TARGET_HOST_IDENTITY_FILE");
const receiptKeyId = required("RELEASE_TARGET_RECEIPT_KEY_ID");
const auditorUrl = required("RELEASE_TARGET_AUDITOR_URL");
const auditorSharedSecretFile = required("RELEASE_TARGET_AUDITOR_SHARED_SECRET_FILE");
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/.test(receiptKeyId)) throw new Error("Receipt key id invalid");
const host = process.env.RELEASE_TARGET_HOST?.trim() || "127.0.0.1";
if (host !== "127.0.0.1") throw new Error("Restricted release target must bind loopback");
const port = numericPort(process.env.RELEASE_TARGET_PORT?.trim() || "3312");
const controlHost = process.env.RELEASE_TARGET_CONTROL_HOST?.trim() || "127.0.0.1";
if (controlHost !== "127.0.0.1") throw new Error("Restricted release target control must bind loopback");
const controlPort = numericPort(process.env.RELEASE_TARGET_CONTROL_PORT?.trim() || "3313");
if (controlPort === port) throw new Error("Target control port must be distinct");

const [
  githubBindingSource, adapterConfigSource, controlIdentitiesSource,
  controlTlsKey, controlTlsCertificate, controlTlsCa, hostIdentity, auditorSharedSecret,
] = await Promise.all([
  readCustodiedJson(githubBindingFile),
  readCustodiedJson(adapterConfigFile),
  readCustodiedJson(controlIdentitiesFile),
  readCustodiedPem(controlTlsKeyFile, true),
  readCustodiedPem(controlTlsCertificateFile, false),
  readCustodiedPem(controlTlsCaFile, false),
  readCustodiedHostIdentity(hostIdentityFile),
  readCustodiedSharedSecret(auditorSharedSecretFile),
]);
const githubBinding = parseRestrictedCicdGithubBinding(githubBindingSource.value);
const adapterConfig = parseRestrictedCicdTargetAdapterConfig(adapterConfigSource.value);
if (githubBinding.environment !== adapterConfig.environment) {
  throw new Error("Target GitHub binding environment does not match adapter environment");
}
const controlIdentities = parseControlIdentities(controlIdentitiesSource.value);
if ([...controlIdentities.target].some((fingerprint) => controlIdentities.breakGlass.has(fingerprint))) {
  throw new Error("Target and break-glass control identities must be disjoint");
}
const controlIdentityConfigSha256 = createHash("sha256")
  .update(controlIdentitiesSource.body)
  .update("\0").update(createHash("sha256").update(controlTlsCertificate).digest("hex"))
  .update("\0").update(createHash("sha256").update(controlTlsCa).digest("hex"))
  .digest("hex");
const ownerEvidenceSha256 = createHash("sha256")
  .update(githubBindingSource.body).update("\0").update(adapterConfigSource.body)
  .update("\0").update(controlIdentitiesSource.body).update("\0").update(hostIdentity).digest("hex");
const implementationFiles = Object.fromEntries(await Promise.all([
  "restricted-cicd-target-engine.ts",
  "restricted-cicd-target-journal.ts",
  "restricted-cicd-target-adapter.ts",
  "restricted-cicd-target.ts",
  "restricted-cicd-github.ts",
  "restricted-cicd-domain.ts",
].map(async (name) => [
  name, await sha256CustodiedFile(fileURLToPath(new URL(`../lib/${name}`, import.meta.url))),
])));
const [composeSha256, composeOverrideSha256, gatewaySha256, packageLockSha256] = await Promise.all([
  sha256CustodiedFile(adapterConfig.composeFile),
  sha256CustodiedFile(adapterConfig.composeOverrideFile),
  sha256CustodiedFile(fileURLToPath(import.meta.url)),
  sha256CustodiedFile(fileURLToPath(new URL("../package-lock.json", import.meta.url))),
]);
const targetInstanceConfigSha256 = createHash("sha256").update(JSON.stringify({
  schemaVersion: "1",
  hostIdentitySha256: createHash("sha256").update(hostIdentity).digest("hex"),
  journalRoot,
  composeSha256,
  composeOverrideSha256,
  gatewaySha256,
  packageLockSha256,
  nodeVersion: process.versions.node,
  implementationFiles,
})).digest("hex");
const targetBindingSha256 = computeRestrictedCicdTargetBindingSha256(
  adapterConfig, controlIdentityConfigSha256, targetInstanceConfigSha256,
);
const receiptPrivateKey = await loadRestrictedCicdReceiptPrivateKey(receiptKeyFile);
const receiptPublicKey = restrictedCicdReceiptPublicKey(receiptPrivateKey);
const receiptTrustPolicy = await loadRestrictedCicdReceiptTrustPolicy(
  receiptTrustFile, receiptPublicKey, receiptKeyId,
);
const receiptTrustSha256 = receiptTrustPolicy.sha256;
if (githubBinding.targetBindingSha256 !== targetBindingSha256
  || githubBinding.receiptTrustSha256 !== receiptTrustSha256) {
  throw new Error("Target local trust does not match frozen provider binding");
}
const ownerIdentitySha256 = createHash("sha256")
  .update("restricted-cicd-target-owner-v1\0").update(targetBindingSha256)
  .update("\0").update(receiptTrustSha256).update("\0").update(adapterConfig.environment)
  .update("\0").update(hostIdentity)
  .digest("hex");
const journal = await createRestrictedCicdTargetJournal(journalRoot);
await journal.recoverOwnedStaleLock(adapterConfig.environment, ownerIdentitySha256);
const adapter = createRestrictedCicdTargetAdapter(adapterConfig);
await adapter.assertCustody();
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  application_name: "agentnovas-release-target",
  connectionTimeoutMillis: 1_500,
  idleTimeoutMillis: 30_000,
  query_timeout: 6_000,
  statement_timeout: 5_000,
  lock_timeout: 2_000,
});
const database = createRestrictedCicdTargetDatabase(pool);
const requestStarts = [];
let recoveryReady = false;
let reconciliationRunning = false;
async function reconcileTargetState() {
  if (reconciliationRunning) return;
  reconciliationRunning = true;
  recoveryReady = false;
  try {
    for (const pending of await journal.listPendingLocalStopRequests(adapterConfig.environment)) {
      await executeRestrictedCicdTargetStop({
        request: pending.request,
        actorFingerprintSha256: pending.actorFingerprintSha256,
        ownerIdentitySha256,
        database,
        journal,
        receiptPrivateKey,
        receiptPublicKeyFor: receiptTrustPolicy.verificationPublicKeyFor,
        receiptKeyId,
        receiptTrustSha256,
      });
    }
    for (const pending of await journal.listPendingLocalStopBackfills(adapterConfig.environment)) {
      await executeRestrictedCicdTargetStop({
        request: {
          schemaVersion: "1",
          stopId: pending.stopId,
          environment: adapterConfig.environment,
          actorKind: pending.actorKind === "break_glass" ? "break_glass" : "user",
          actorIdentity: pending.actorIdentity,
          reason: pending.reason,
        },
        actorFingerprintSha256: pending.actorFingerprintSha256,
        ownerIdentitySha256,
        database,
        journal,
        receiptPrivateKey,
        receiptPublicKeyFor: receiptTrustPolicy.verificationPublicKeyFor,
        receiptKeyId,
        receiptTrustSha256,
      });
    }
    const databaseRecoverable = await database.listRecoverable({
      environment: adapterConfig.environment,
      ownerIdentitySha256,
      targetBindingSha256,
      receiptTrustSha256,
    });
    const databaseRecoveryIds = new Set(databaseRecoverable.map((item) => item.operationId));
    for (const localJournal of await journal.listRecoverable(adapterConfig.environment)) {
      if (!databaseRecoveryIds.has(localJournal.operationId)) {
        throw new Error("Target-local journal is not owned by the database recovery source");
      }
    }
    for (const recoveryCandidate of databaseRecoverable) {
      await journal.recoverOwnedStaleOperationLock(recoveryCandidate.operationId, ownerIdentitySha256);
      const recovery = await database.recover({
        operationId: recoveryCandidate.operationId,
        commandId: recoveryCandidate.commandId,
        ownerIdentitySha256,
        targetBindingSha256,
        receiptTrustSha256,
      });
      await executeRestrictedCicdTargetOperation({
        identity: recovery.identity,
        material: recovery.deployment,
        ownerEpoch: recovery.ownerEpoch,
        ownerIdentitySha256,
        database,
        journal,
        adapter,
        receiptPrivateKey,
        receiptPublicKeyFor: receiptTrustPolicy.verificationPublicKeyFor,
        receiptKeyId,
        targetBindingSha256,
        receiptTrustSha256,
      });
    }
    recoveryReady = true;
  } catch {
    recoveryReady = false;
  } finally {
    reconciliationRunning = false;
  }
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/internal/restricted-cicd/deploy"
    || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    respond(response, 404, { ok: false, code: "not_found" });
    return;
  }
  try {
    if (!recoveryReady) throw new Error("target recovery not ready");
    const currentTime = Date.now();
    while (requestStarts.length && requestStarts[0] <= currentTime - 60_000) requestStarts.shift();
    if (requestStarts.length >= 30) {
      respond(response, 429, { ok: false, code: "rate_limited" });
      return;
    }
    requestStarts.push(currentTime);
    const requested = parseRestrictedCicdWorkflowTargetRequest(JSON.parse(await receiveBody(request)));
    if (requested.environment !== adapterConfig.environment) throw new Error("environment mismatch");
    const jwks = await fetchRestrictedCicdGithubOidcJwks();
    const oidc = verifyRestrictedCicdGithubOidcToken({
      token: requested.oidcToken,
      jwks,
      binding: githubBinding,
      providerRunId: requested.providerRunId,
      jobId: requested.jobId,
      environment: requested.environment,
    });
    await auditRestrictedCicdTargetRun({
      url: auditorUrl,
      sharedSecret: auditorSharedSecret,
      request: {
        schemaVersion: "1",
        providerRunId: oidc.providerRunId,
        jobId: oidc.jobId,
        environment: oidc.environment,
        oidcJtiSha256: oidc.jtiSha256,
        oidcClaimsSha256: oidc.claimsSha256,
        oidcIssuedAt: oidc.issuedAt.toISOString(),
        oidcExpiresAt: oidc.expiresAt.toISOString(),
      },
    });
    const reservation = await database.reserveWorkflow(requested, oidc, {
      identitySha256: ownerIdentitySha256,
      evidenceSha256: ownerEvidenceSha256,
      targetBindingSha256,
      receiptTrustSha256,
      auditorTrustSha256: githubBinding.auditorTrustSha256,
    });
    const result = await executeRestrictedCicdTargetOperation({
      identity: reservation.identity,
      material: reservation.deployment,
      ownerEpoch: reservation.ownerEpoch,
      ownerIdentitySha256,
      database,
      journal,
      adapter,
      receiptPrivateKey,
      receiptPublicKeyFor: receiptTrustPolicy.verificationPublicKeyFor,
      receiptKeyId,
      targetBindingSha256,
      receiptTrustSha256,
    });
    respond(response, result.phase === "health_verified" ? 200 : 409, {
      ok: true,
      operationId: reservation.operationId,
      phase: result.phase,
      replayed: reservation.replayed || result.replayed,
    });
  } catch (error) {
    const internalCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const busy = internalCode === "TARGET_MUTEX_BUSY";
    const uncertain = internalCode.includes("UNCERTAIN");
    respond(response, busy ? 409 : 403, {
      ok: false,
      code: busy ? "target_busy" : uncertain ? "target_operation_uncertain" : "target_request_rejected",
    });
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(port, host);

const controlServer = createSecureServer({
  key: controlTlsKey,
  cert: controlTlsCertificate,
  ca: controlTlsCa,
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: "TLSv1.3",
}, async (request, response) => {
  const controlPaths = new Set([
    "/internal/restricted-cicd/stop",
    "/internal/restricted-cicd/clear-stop-ack",
    "/internal/restricted-cicd/clear-stop-commit",
  ]);
  if (request.method !== "POST" || !controlPaths.has(request.url ?? "")
    || request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    respond(response, 404, { ok: false, code: "not_found" });
    return;
  }
  try {
    const requested = request.url === "/internal/restricted-cicd/stop"
      ? parseRestrictedCicdTargetStopRequest(JSON.parse(await receiveBody(request)))
      : parseRestrictedCicdTargetClearRequest(JSON.parse(await receiveBody(request)));
    if (requested.environment !== adapterConfig.environment) throw new Error("environment mismatch");
    const certificate = request.socket.getPeerCertificate();
    const fingerprint = certificate.fingerprint256?.replaceAll(":", "").toLowerCase();
    if (!request.socket.authorized || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error("control identity missing");
    }
    const allowlist = "actorKind" in requested && requested.actorKind === "break_glass"
      ? controlIdentities.breakGlass : controlIdentities.target;
    if (!allowlist.has(fingerprint)) throw new Error("control identity rejected");
    const common = {
      request: requested,
      actorFingerprintSha256: fingerprint,
      ownerIdentitySha256,
      database,
      journal,
      receiptPrivateKey,
      receiptPublicKeyFor: receiptTrustPolicy.verificationPublicKeyFor,
      receiptKeyId,
      receiptTrustSha256,
    };
    const result = request.url === "/internal/restricted-cicd/stop"
      ? await executeRestrictedCicdTargetStop({ ...common, request: requested })
      : request.url === "/internal/restricted-cicd/clear-stop-ack"
        ? await executeRestrictedCicdTargetClearAcknowledgement({
          ...common, request: requested,
        })
        : await executeRestrictedCicdTargetClearCommit({ ...common, request: requested });
    respond(response, 200, { ok: true, stopId: requested.stopId, ...result });
  } catch (error) {
    const internalCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (request.url === "/internal/restricted-cicd/stop" && internalCode === "TARGET_MUTEX_BUSY") {
      respond(response, 202, { ok: true, code: "stop_pending" });
      return;
    }
    respond(response, internalCode === "TARGET_MUTEX_BUSY" ? 409 : 403, {
      ok: false,
      code: internalCode === "TARGET_MUTEX_BUSY" ? "target_busy" : "target_stop_rejected",
    });
  }
});
controlServer.requestTimeout = 10_000;
controlServer.headersTimeout = 5_000;
await new Promise((resolve, reject) => {
  controlServer.once("error", reject);
  controlServer.listen(controlPort, controlHost, resolve);
});
void reconcileTargetState();
const reconciliationTimer = setInterval(() => void reconcileTargetState(), 30_000);
reconciliationTimer.unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    clearInterval(reconciliationTimer);
    controlServer.close(() => server.close(() => {
    pool.end().finally(() => process.exit(0));
    }));
  });
}
