#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/;
const MIGRATION = /^[0-9]{4}_[a-z0-9_]+$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

export const REQUIRED_RESTRICTED_CICD_G7_GATES = Object.freeze([
  "binding_drift",
  "secret_custody",
  "direct_dispatch_rerun",
  "production_staging_approval",
  "concurrency_toctou",
  "callback_replay",
  "runner_compromise",
  "rollback_recovery",
  "stop_cutover",
  "break_glass",
  "activation_first_enablement",
]);

export const REQUIRED_RESTRICTED_CICD_G7_ASSERTIONS = Object.freeze({
  binding_drift: Object.freeze([
    "provider_app_scope_exact", "auditor_app_scope_exact", "workflow_digest_exact",
    "environment_policy_exact", "runner_policy_exact",
  ]),
  secret_custody: Object.freeze([
    "no_long_term_runner_secret", "private_key_file_custody", "database_role_least_privilege",
  ]),
  direct_dispatch_rerun: Object.freeze([
    "unbound_run_rejected", "rerun_rejected", "oidc_replay_rejected",
  ]),
  production_staging_approval: Object.freeze([
    "same_artifact_manifest", "distinct_platform_approvers", "staging_receipt_required",
    "provider_self_review_rejected",
  ]),
  concurrency_toctou: Object.freeze([
    "generation_fenced", "expected_current_cas", "owner_epoch_fenced", "policy_attestation_current",
  ]),
  callback_replay: Object.freeze([
    "webhook_hmac_verified", "delivery_replay_idempotent", "out_of_order_monotonic",
    "authoritative_run_requeried",
  ]),
  runner_compromise: Object.freeze([
    "snapshot_scope_fixed", "no_privileged_runner_secret", "forged_receipt_rejected",
    "forged_output_ignored",
  ]),
  rollback_recovery: Object.freeze([
    "historical_target_required", "migration_registry_compatible", "irreversible_migration_rejected",
    "backup_fresh_and_verified",
  ]),
  stop_cutover: Object.freeze([
    "shared_mutex_linearized", "late_receipt_preserved", "exact_run_cancel_requested",
    "sticky_generation_incremented",
  ]),
  break_glass: Object.freeze([
    "independent_mtls_identity", "authorization_epoch_incremented", "signed_backfill_reconciled",
    "database_unavailable_fail_closed",
  ]),
  activation_first_enablement: Object.freeze([
    "distinct_activation_approvers", "digest_and_expiry_bound", "first_production_enablement_required",
    "environment_variable_bypass_rejected",
  ]),
});

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected) {
  if (!object(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

function validCandidate(candidate) {
  return exactKeys(candidate, [
    "commitSha", "workflowSha256", "providerBindingSha256", "targetBindingSha256",
    "receiptTrustSha256", "auditorTrustSha256", "migrationRegistrySha256", "migrationVersion",
  ])
    && COMMIT.test(candidate.commitSha)
    && MIGRATION.test(candidate.migrationVersion)
    && Object.entries(candidate).every(([key, value]) => (
      key === "commitSha" || key === "migrationVersion" || SHA256.test(value)
    ));
}

function validPolicies(policies) {
  return exactKeys(policies, [
    "environmentPolicySha256", "runnerPolicySha256", "productionReviewerAllowlistSha256",
    "providerFixtureSha256",
  ]) && Object.values(policies).every((value) => SHA256.test(value));
}

export function computeRestrictedCicdG7SubjectSha256(candidate, policies) {
  if (!validCandidate(candidate) || !validPolicies(policies)) {
    throw new Error("Restricted CI/CD G7 subject invalid");
  }
  return digest(canonical({ candidate, policies }));
}

async function evidenceFile(path, expectedGate, expectedSubjectSha256, expectedFixtureSha256, generatedAt) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`G7 evidence file invalid: ${expectedGate}`);
  }
  const body = await readFile(absolute);
  let result;
  try { result = JSON.parse(body.toString("utf8")); } catch { throw new Error(`G7 evidence JSON invalid: ${expectedGate}`); }
  if (!exactKeys(result, [
    "schemaVersion", "gate", "passed", "subjectSha256", "providerFixtureSha256",
    "externalWritesEnabled", "startedAt", "completedAt", "assertions", "artifacts",
  ]) || result.schemaVersion !== "2" || result.gate !== expectedGate || result.passed !== true
    || result.subjectSha256 !== expectedSubjectSha256
    || result.providerFixtureSha256 !== expectedFixtureSha256
    || result.externalWritesEnabled !== false
    || !exactTimestamp(result.startedAt) || !exactTimestamp(result.completedAt)
    || !Array.isArray(result.assertions) || !Array.isArray(result.artifacts)) {
    throw new Error(`G7 gate did not pass: ${expectedGate}`);
  }
  const startedAt = new Date(result.startedAt).getTime();
  const completedAt = new Date(result.completedAt).getTime();
  const generated = new Date(generatedAt).getTime();
  if (completedAt < startedAt || completedAt > generated || generated - completedAt > MAX_EVIDENCE_AGE_MS) {
    throw new Error(`G7 gate did not pass: ${expectedGate}`);
  }
  const requiredAssertions = REQUIRED_RESTRICTED_CICD_G7_ASSERTIONS[expectedGate];
  const assertions = result.assertions.map((assertion) => {
    if (!exactKeys(assertion, ["name", "passed"]) || typeof assertion.name !== "string"
      || assertion.passed !== true) throw new Error(`G7 gate did not pass: ${expectedGate}`);
    return assertion.name;
  });
  if (assertions.length !== requiredAssertions.length
    || [...assertions].sort().join("|") !== [...requiredAssertions].sort().join("|")) {
    throw new Error(`G7 gate did not pass: ${expectedGate}`);
  }
  if (result.artifacts.length < 1 || result.artifacts.length > 20) {
    throw new Error(`G7 gate did not pass: ${expectedGate}`);
  }
  const artifactNames = new Set();
  const artifacts = result.artifacts.map((artifact) => {
    if (!exactKeys(artifact, ["name", "sha256", "bytes"]) || !ARTIFACT_NAME.test(artifact.name)
      || !SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 1 || artifact.bytes > MAX_ARTIFACT_BYTES || artifactNames.has(artifact.name)) {
      throw new Error(`G7 gate did not pass: ${expectedGate}`);
    }
    artifactNames.add(artifact.name);
    return artifact;
  });
  return {
    gate: expectedGate, sha256: digest(body), bytes: body.length,
    startedAt: result.startedAt, completedAt: result.completedAt, artifacts,
  };
}

export async function buildRestrictedCicdG7EvidenceManifest(input) {
  if (!exactKeys(input, ["schemaVersion", "candidate", "policies", "approvers", "generatedAt", "evidence"])
    || input.schemaVersion !== "2"
    || !validCandidate(input.candidate)
    || !validPolicies(input.policies)
    || !exactKeys(input.approvers, ["securityActorId", "releaseActorId"])
    || !IDENTIFIER.test(input.approvers.securityActorId)
    || !IDENTIFIER.test(input.approvers.releaseActorId)
    || input.approvers.securityActorId === input.approvers.releaseActorId
    || new Date(input.generatedAt).toISOString() !== input.generatedAt
    || !Array.isArray(input.evidence)) {
    if (input?.approvers?.securityActorId === input?.approvers?.releaseActorId) {
      throw new Error("Restricted CI/CD requires distinct G7 approvers");
    }
    throw new Error("Restricted CI/CD G7 manifest input invalid");
  }
  const evidenceByGate = new Map();
  for (const item of input.evidence) {
    if (!exactKeys(item, ["gate", "path"]) || !REQUIRED_RESTRICTED_CICD_G7_GATES.includes(item.gate)
      || typeof item.path !== "string" || evidenceByGate.has(item.gate)) {
      throw new Error("Restricted CI/CD G7 evidence list invalid");
    }
    evidenceByGate.set(item.gate, item.path);
  }
  if (evidenceByGate.size !== REQUIRED_RESTRICTED_CICD_G7_GATES.length) {
    throw new Error("Restricted CI/CD G7 evidence incomplete");
  }
  const subjectSha256 = computeRestrictedCicdG7SubjectSha256(input.candidate, input.policies);
  const evidence = [];
  for (const gate of REQUIRED_RESTRICTED_CICD_G7_GATES) {
    evidence.push(await evidenceFile(
      evidenceByGate.get(gate), gate, subjectSha256,
      input.policies.providerFixtureSha256, input.generatedAt,
    ));
  }
  const unsigned = {
    schemaVersion: "2",
    subjectSha256,
    candidate: input.candidate,
    policies: input.policies,
    approvers: input.approvers,
    generatedAt: input.generatedAt,
    evidence,
  };
  return { ...unsigned, g7ManifestSha256: digest(canonical(unsigned)) };
}

async function main() {
  const inputIndex = process.argv.indexOf("--input");
  const outputIndex = process.argv.indexOf("--output");
  if (inputIndex < 0 || outputIndex < 0 || !process.argv[inputIndex + 1] || !process.argv[outputIndex + 1]) {
    throw new Error("Usage: restricted-cicd-g7-evidence --input <json> --output <json>");
  }
  const input = JSON.parse(await readFile(resolve(process.argv[inputIndex + 1]), "utf8"));
  const manifest = await buildRestrictedCicdG7EvidenceManifest(input);
  await writeFile(resolve(process.argv[outputIndex + 1]), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: "verified", g7ManifestSha256: manifest.g7ManifestSha256 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Restricted CI/CD G7 evidence failed"}\n`);
    process.exitCode = 1;
  });
}
