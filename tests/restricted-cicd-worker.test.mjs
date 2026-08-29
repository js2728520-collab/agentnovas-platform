import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  RestrictedCicdGithubError,
  computeRestrictedCicdProviderBindingSha256,
  parseRestrictedCicdGithubBinding,
} from "../lib/restricted-cicd-github.ts";
import {
  createRestrictedCicdWorkerDatabase,
  runRestrictedCicdReconciliationIteration,
  runRestrictedCicdWorkerIteration,
} from "../lib/restricted-cicd-worker.ts";

const sha = (letter) => letter.repeat(64);
const commit = (letter) => letter.repeat(40);
const bindingInput = {
  provider: "github_actions",
  apiVersion: "2026-03-10",
  apiBaseUrl: "https://api.github.com",
  repositoryOwner: "agentnovas",
  repositoryName: "platform",
  repositoryId: "123456789",
  appId: "24680",
  installationId: "13579",
  accountId: "11223344",
  appPrivateKeyFile: "/run/secrets/restricted-cicd-app.pem",
  workflowId: "99887766",
  workflowPath: ".github/workflows/restricted-deployment.yml",
  workflowControlRef: "refs/tags/release-control-v1",
  controlCommitSha: commit("a"),
  workflowSha256: sha("b"),
  environment: "staging",
  oidcAudience: "https://deploy.agentnovas.internal",
  runnerEnvironment: "github-hosted",
  g7ManifestSha256: sha("c"),
  providerBindingSha256: sha("d"),
  environmentPolicySha256: sha("e"),
  productionReviewerAllowlistSha256: sha("f"),
  runnerPolicySha256: sha("1"),
  targetBindingSha256: sha("2"),
  receiptTrustSha256: sha("3"),
  auditorTrustSha256: sha("4"),
};
bindingInput.providerBindingSha256 = computeRestrictedCicdProviderBindingSha256(bindingInput);
const binding = parseRestrictedCicdGithubBinding(bindingInput);
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function claim() {
  return {
    attemptKey: "attempt-fixed",
    fencingToken: 7,
    commandId: "command-1",
    releaseVersionId: "release-1",
    environment: "staging",
    action: "deploy",
    snapshotSha256: sha("5"),
    artifactManifestSha256: sha("6"),
    workflowSha256: binding.workflowSha256,
    environmentGeneration: 3,
    expectedCurrentReleaseVersionId: null,
    leaseExpiresAt: new Date(Date.now() + 300_000),
    activationId: "activation-1",
    replayed: false,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const database = {
    recoverExpiredDispatch: async (environment) => { calls.push(["recover", environment]); return null; },
    claimNextReconciliation: async () => { calls.push(["claim-reconciliation"]); return null; },
    claimNext: async (input) => { calls.push(["claim", input]); return claim(); },
    beginDispatch: async (input) => { calls.push(["begin", input]); return { replayed: false }; },
    bindProviderRun: async (input) => { calls.push(["bind", input]); return { providerRunId: input.providerRunId, replayed: false }; },
    recordDispatchUnknown: async (input) => { calls.push(["unknown", input]); return { recorded: true, providerRunId: null, replayed: false }; },
    rejectBoundRun: async (input) => { calls.push(["reject", input]); return { eventId: input.eventId, replayed: false }; },
    appendProviderEvent: async (input) => { calls.push(["append-provider-event", input]); return { eventId: input.eventId, replayed: false }; },
    ...(overrides.database ?? {}),
  };
  const provider = {
    withInstallationToken: async (callback) => { calls.push(["token"]); return callback("local-installation-token"); },
    verifyBinding: async () => { calls.push(["verify-binding"]); return { controlCommitSha: commit("a"), workflowSha256: sha("b") }; },
    dispatchPrepared: async (_token, prepared) => {
      calls.push(["dispatch", prepared]);
      return {
        providerRunId: "778899",
        providerRunUrl: "https://github.com/agentnovas/platform/actions/runs/778899",
        dispatchRequestSha256: prepared.dispatchRequestSha256,
      };
    },
    verifyRun: async (_token, runId) => { calls.push(["verify-run", runId]); return { providerRunId: runId, runAttempt: 1, headSha: commit("a") }; },
    cancelRun: async (_token, runId) => { calls.push(["cancel", runId]); return { providerRunId: runId, cancellationRequested: true }; },
    ...(overrides.provider ?? {}),
  };
  return { calls, database, provider };
}

function reconciliationCandidate() {
  return {
    attemptKey: "attempt-fixed",
    commandId: "command-1",
    workerId: "release-worker-test",
    fencingToken: 7,
    providerRunId: "778899",
  };
}

test("reconciliation verifies the immutable binding and appends authoritative provider state", async () => {
  const updatedAt = "2026-08-27T08:09:10.000Z";
  const { calls, database, provider } = harness({
    database: {
      claimNextReconciliation: async (input) => {
        calls.push(["claim-reconciliation", input]);
        return reconciliationCandidate();
      },
    },
    provider: {
      verifyRun: async (_token, runId) => {
        calls.push(["verify-run", runId]);
        return {
          providerRunId: runId,
          runAttempt: 1,
          headSha: commit("a"),
          status: "in_progress",
          conclusion: null,
          updatedAt,
        };
      },
    },
  });
  const result = await runRestrictedCicdReconciliationIteration(database, binding, privateKey, { provider });
  assert.deepEqual(result, {
    outcome: "provider_reconciled",
    commandId: "command-1",
    providerRunId: "778899",
    providerEventKind: "provider_in_progress",
  });
  assert.deepEqual(calls.map(([name]) => name), [
    "token", "verify-binding", "claim-reconciliation", "verify-run", "append-provider-event",
  ]);
  const appended = calls.find(([name]) => name === "append-provider-event")[1];
  assert.equal(appended.occurredAt.toISOString(), updatedAt);
  assert.deepEqual(appended.metadata, {
    runId: "778899",
    runAttempt: 1,
    status: "in_progress",
    conclusion: null,
    providerUpdatedAt: updatedAt,
  });
  assert.match(appended.eventId, /^provider-[a-f0-9]{48}$/);
  assert.match(appended.evidenceSha256, /^[a-f0-9]{64}$/);
});

test("worker refuses a database claim outside its immutable environment before dispatch", async () => {
  const { calls, database, provider } = harness({
    database: {
      claimNext: async (input) => {
        calls.push(["claim", input]);
        return { ...claim(), environment: "production" };
      },
    },
  });
  await assert.rejects(
    () => runRestrictedCicdWorkerIteration(database, binding, privateKey, {
      workerId: "release-worker-staging",
      provider,
    }),
    /claim environment mismatch/i,
  );
  assert.equal(calls.some(([name]) => name === "begin" || name === "dispatch"), false);
});

test("reconciliation normalizes every non-success terminal conclusion to a deterministic failure fact", async () => {
  const { calls, database, provider } = harness({
    database: {
      claimNextReconciliation: async () => reconciliationCandidate(),
    },
    provider: {
      verifyRun: async (_token, runId) => ({
        providerRunId: runId,
        runAttempt: 1,
        headSha: commit("a"),
        status: "completed",
        conclusion: "timed_out",
        updatedAt: "2026-08-27T08:09:11.000Z",
      }),
    },
  });
  const result = await runRestrictedCicdReconciliationIteration(database, binding, privateKey, { provider });
  assert.equal(result.providerEventKind, "completed_failure");
  const appended = calls.find(([name]) => name === "append-provider-event")[1];
  assert.equal(appended.metadata.conclusion, "failure");
});

test("reconciliation quarantines an exact-run mismatch before best-effort cancellation", async () => {
  const { calls, database, provider } = harness({
    database: {
      claimNextReconciliation: async () => reconciliationCandidate(),
    },
    provider: {
      verifyRun: async () => {
        calls.push(["verify-run"]);
        throw new RestrictedCicdGithubError("EXACT_RUN_MISMATCH", "safe mismatch");
      },
    },
  });
  const result = await runRestrictedCicdReconciliationIteration(database, binding, privateKey, {
    provider,
    eventIdFactory: () => "reconciliation-mismatch-event",
  });
  assert.deepEqual(result, {
    outcome: "manual_intervention",
    commandId: "command-1",
    providerRunId: "778899",
    reasonCode: "exact_run_mismatch",
    cancellationRequested: true,
  });
  const names = calls.map(([name]) => name);
  assert.ok(names.indexOf("reject") < names.indexOf("cancel"));
});

test("iteration verifies drift before claim and persists the exact request before POST", async () => {
  const { calls, database, provider } = harness();
  const result = await runRestrictedCicdWorkerIteration(database, binding, privateKey, {
    workerId: "release-worker-test",
    attemptKeyFactory: () => "attempt-fixed",
    provider,
  });
  assert.deepEqual(result, { outcome: "dispatch_accepted", commandId: "command-1", providerRunId: "778899" });
  assert.deepEqual(calls.map(([name]) => name), [
    "recover", "token", "verify-binding", "claim", "begin", "dispatch", "bind", "verify-run",
  ]);
  const begin = calls.find(([name]) => name === "begin")[1];
  const dispatch = calls.find(([name]) => name === "dispatch")[1];
  assert.equal(begin.dispatchRequestSha256, dispatch.dispatchRequestSha256);
  assert.match(begin.dispatchRequestSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(dispatch.requestBody).inputs.command_id, "command-1");
});

test("database adapter accepts pg timestamptz Date values and maps only the narrow claim gateway", async () => {
  const leaseExpiresAt = new Date(Date.now() + 300_000);
  const queries = [];
  const database = createRestrictedCicdWorkerDatabase({
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes("recover_expired_dispatch")) return { rows: [] };
      return { rows: [{
        attempt_key: "attempt-fixed",
        fencing_token: "7",
        command_id: "command-1",
        release_version_id: "release-1",
        environment: "staging",
        action: "deploy",
        snapshot_sha256: sha("5"),
        artifact_manifest_sha256: sha("6"),
        workflow_sha256: binding.workflowSha256,
        environment_generation: "3",
        expected_current_release_version_id: null,
        lease_expires_at: leaseExpiresAt,
        activation_id: "activation-1",
        replayed: false,
      }] };
    },
  });
  assert.equal(await database.recoverExpiredDispatch("staging"), null);
  const claimed = await database.claimNext({
    attemptKey: "attempt-fixed",
    workerId: "release-worker-test",
    leaseSeconds: 300,
    binding,
  });
  assert.equal(claimed.leaseExpiresAt.toISOString(), leaseExpiresAt.toISOString());
  assert.match(queries[1].sql, /release_workflow_claim_next_command_v2/);
  assert.equal(queries[1].values.length, 13);
  assert.equal(queries[1].values[3], "staging");
});

test("unknown dispatch response records an uncertainty fact and never binds or retries POST", async () => {
  const { calls, database, provider } = harness({
    provider: {
      dispatchPrepared: async () => {
        calls.push(["dispatch"]);
        throw new RestrictedCicdGithubError("DISPATCH_OUTCOME_UNKNOWN", "safe error");
      },
    },
  });
  const result = await runRestrictedCicdWorkerIteration(database, binding, privateKey, {
    workerId: "release-worker-test",
    attemptKeyFactory: () => "attempt-fixed",
    provider,
  });
  assert.deepEqual(result, { outcome: "manual_intervention", commandId: "command-1", reasonCode: "transport_failure" });
  assert.deepEqual(calls.map(([name]) => name), [
    "recover", "token", "verify-binding", "claim", "begin", "dispatch", "unknown",
  ]);
});

test("a replayed begin-dispatch is treated as recovery uncertainty and does not issue POST", async () => {
  const { calls, database, provider } = harness({
    database: {
      beginDispatch: async (input) => { calls.push(["begin", input]); return { replayed: true }; },
    },
  });
  const result = await runRestrictedCicdWorkerIteration(database, binding, privateKey, {
    workerId: "release-worker-test",
    attemptKeyFactory: () => "attempt-fixed",
    provider,
  });
  assert.equal(result.outcome, "manual_intervention");
  assert.equal(result.reasonCode, "worker_recovery");
  assert.deepEqual(calls.map(([name]) => name), ["recover", "token", "verify-binding", "claim", "begin", "unknown"]);
});

test("exact-run mismatch is quarantined before cancellation is requested", async () => {
  const { calls, database, provider } = harness({
    provider: {
      verifyRun: async () => {
        calls.push(["verify-run"]);
        throw new RestrictedCicdGithubError("EXACT_RUN_MISMATCH", "safe mismatch");
      },
    },
  });
  const result = await runRestrictedCicdWorkerIteration(database, binding, privateKey, {
    workerId: "release-worker-test",
    attemptKeyFactory: () => "attempt-fixed",
    provider,
  });
  assert.deepEqual(result, {
    outcome: "manual_intervention",
    commandId: "command-1",
    providerRunId: "778899",
    reasonCode: "exact_run_mismatch",
    cancellationRequested: true,
  });
  const names = calls.map(([name]) => name);
  assert.ok(names.indexOf("reject") < names.indexOf("cancel"));
  assert.equal(calls.find(([name]) => name === "reject")[1].reasonCode, "exact_run_mismatch");
});

test("an uncertain bind retries only the idempotent bind and uses the committed run returned by uncertainty gateway", async () => {
  let bindCalls = 0;
  const { calls, database, provider } = harness({
    database: {
      bindProviderRun: async (input) => {
        calls.push(["bind", input]);
        bindCalls += 1;
        throw new Error("database connection outcome unknown");
      },
      recordDispatchUnknown: async (input) => {
        calls.push(["unknown", input]);
        return { recorded: false, providerRunId: "778899", replayed: false };
      },
    },
  });
  const result = await runRestrictedCicdWorkerIteration(database, binding, privateKey, {
    workerId: "release-worker-test",
    attemptKeyFactory: () => "attempt-fixed",
    provider,
  });
  assert.equal(bindCalls, 2);
  assert.deepEqual(result, { outcome: "dispatch_accepted", commandId: "command-1", providerRunId: "778899" });
  assert.deepEqual(calls.map(([name]) => name), [
    "recover", "token", "verify-binding", "claim", "begin", "dispatch", "bind", "bind", "unknown", "verify-run",
  ]);
});

test("an expired persisted dispatch is quarantined before minting or claiming", async () => {
  const { calls, database, provider } = harness({
    database: {
      recoverExpiredDispatch: async () => {
        calls.push(["recover"]);
        return { attemptKey: "attempt-old", commandId: "command-old" };
      },
    },
  });
  const result = await runRestrictedCicdWorkerIteration(database, binding, privateKey, {
    workerId: "release-worker-test",
    provider,
  });
  assert.deepEqual(result, {
    outcome: "manual_intervention",
    commandId: "command-old",
    reasonCode: "worker_recovery",
  });
  assert.deepEqual(calls.map(([name]) => name), ["recover"]);
});

test("verified provider or claimed workflow drift fails before dispatch persistence", async () => {
  {
    const { calls, database, provider } = harness({
      provider: {
        verifyBinding: async () => {
          calls.push(["verify-binding"]);
          return { controlCommitSha: commit("9"), workflowSha256: binding.workflowSha256 };
        },
      },
    });
    await assert.rejects(
      runRestrictedCicdWorkerIteration(database, binding, privateKey, {
        workerId: "release-worker-test",
        provider,
      }),
      (error) => error instanceof RestrictedCicdGithubError && error.code === "PROVIDER_BINDING_DRIFT",
    );
    assert.deepEqual(calls.map(([name]) => name), ["recover", "token", "verify-binding"]);
  }
  {
    const { calls, database, provider } = harness({
      database: {
        claimNext: async (input) => {
          calls.push(["claim", input]);
          return { ...claim(), workflowSha256: sha("9") };
        },
      },
    });
    await assert.rejects(
      runRestrictedCicdWorkerIteration(database, binding, privateKey, {
        workerId: "release-worker-test",
        provider,
      }),
      (error) => error instanceof RestrictedCicdGithubError && error.code === "PROVIDER_BINDING_DRIFT",
    );
    assert.deepEqual(calls.map(([name]) => name), ["recover", "token", "verify-binding", "claim"]);
  }
});
