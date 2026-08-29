import assert from "node:assert/strict";
import test from "node:test";

import { runRestrictedCicdWorkflowClient } from "../scripts/release/restricted-cicd-workflow-client.mjs";

const sha = (letter) => letter.repeat(64);

function token(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "fixture-signature",
  ].join(".");
}

test("workflow client exchanges GitHub OIDC for one strict server-derived target request", async () => {
  const oidcToken = token({
    run_id: "9001", run_attempt: "1", check_run_id: "9002", environment: "staging",
  });
  const calls = [];
  const result = await runRestrictedCicdWorkflowClient({
    INPUT_SCHEMA_VERSION: "2",
    INPUT_COMMAND_ID: "command-staging-1",
    INPUT_RELEASE_VERSION_ID: "release-staging-1",
    INPUT_ENVIRONMENT: "staging",
    INPUT_ACTION: "deploy",
    INPUT_ARTIFACT_MANIFEST_SHA256: sha("a"),
    INPUT_ENVIRONMENT_GENERATION: "7",
    RESTRICTED_CICD_TARGET_URL: "https://deploy.agentnovas.internal/internal/restricted-cicd/deploy",
    RESTRICTED_CICD_OIDC_AUDIENCE: "https://deploy.agentnovas.internal",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/request?x=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-request-token",
    GITHUB_RUN_ID: "9001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "b".repeat(40),
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return new Response(JSON.stringify({ value: oidcToken }), {
        status: 200, headers: { "content-type": "application/json" },
      });
      return new Response(JSON.stringify({ ok: true, operationId: "operation-staging-1", phase: "health_verified", replayed: false }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(result, { operationId: "operation-staging-1", phase: "health_verified", replayed: false });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /audience=https%3A%2F%2Fdeploy\.agentnovas\.internal/);
  assert.equal(calls[0].options.headers.authorization, "Bearer ephemeral-request-token");
  const request = JSON.parse(calls[1].options.body);
  assert.deepEqual(request, {
    schemaVersion: "2",
    commandId: "command-staging-1",
    releaseVersionId: "release-staging-1",
    providerRunId: "9001",
    jobId: "9002",
    environment: "staging",
    action: "deploy",
    artifactManifestSha256: sha("a"),
    environmentGeneration: 7,
    controlCommitSha: "b".repeat(40),
    oidcToken,
  });
});

test("workflow client rejects reruns, mutable endpoints and OIDC context drift before target POST", async () => {
  const base = {
    INPUT_SCHEMA_VERSION: "2", INPUT_COMMAND_ID: "command-staging-1",
    INPUT_RELEASE_VERSION_ID: "release-staging-1", INPUT_ENVIRONMENT: "staging", INPUT_ACTION: "deploy",
    INPUT_ARTIFACT_MANIFEST_SHA256: sha("a"), INPUT_ENVIRONMENT_GENERATION: "7",
    RESTRICTED_CICD_TARGET_URL: "https://deploy.agentnovas.internal/internal/restricted-cicd/deploy",
    RESTRICTED_CICD_OIDC_AUDIENCE: "https://deploy.agentnovas.internal",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/request",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "ephemeral-request-token", GITHUB_RUN_ID: "9001",
    GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "b".repeat(40),
  };
  await assert.rejects(runRestrictedCicdWorkflowClient(base, { fetchImpl: async () => { throw new Error("network must remain unused"); } }), /workflow context invalid/i);
  await assert.rejects(runRestrictedCicdWorkflowClient({ ...base, GITHUB_RUN_ATTEMPT: "1", RESTRICTED_CICD_TARGET_URL: "http://127.0.0.1/internal/restricted-cicd/deploy" }, { fetchImpl: async () => { throw new Error("network must remain unused"); } }), /target URL invalid/i);
});
