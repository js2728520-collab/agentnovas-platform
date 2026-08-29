import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `restricted_cicd_worker_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema}` });
const sha = (letter) => letter.repeat(64);

const binding = Object.freeze({
  g7: sha("1"),
  provider: Object.freeze({ staging: sha("2"), production: sha("9") }),
  environment: sha("3"),
  runner: sha("4"),
  target: sha("5"),
  receipt: sha("6"),
  auditor: sha("7"),
  reviewer: sha("8"),
  artifact: sha("c"),
  workflow: sha("d"),
});
const providerMaterial = (environment) => Object.freeze({
  provider: "github_actions",
  apiVersion: "2026-03-10",
  apiBaseUrl: "https://api.github.com",
  repositoryOwner: "agentnovas",
  repositoryName: "platform",
  repositoryId: "123456789",
  appId: "24680",
  installationId: "13579",
  accountId: "11223344",
  workflowId: "99887766",
  workflowPath: ".github/workflows/restricted-deployment.yml",
  workflowControlRef: "refs/tags/release-control-v1",
  controlCommitSha: "a".repeat(40),
  workflowSha256: binding.workflow,
  environment,
  oidcAudience: "https://deploy.agentnovas.internal",
  runnerEnvironment: "github-hosted",
});

async function createCommand(environment, suffix) {
  const commandId = `command-${environment}-${suffix}`;
  const snapshot = {
    schemaVersion: "1",
    commandId,
    releaseVersionId: "release-worker",
    environment,
    action: "deploy",
    artifactManifestSha256: binding.artifact,
    workflowSha256: binding.workflow,
    environmentGeneration: 1,
    expectedCurrentReleaseVersionId: null,
  };
  await pool.query(`
    SELECT * FROM release_workflow_request_command(
      $1,'release-worker',$2,'deploy',$3,'release-maker',$4,$5,$6,$7::jsonb,$8,$9,1,NULL
    )
  `, [
    commandId,
    environment,
    `Request ${environment} worker dispatch`,
    `idem-${environment}-${suffix}`,
    sha(suffix === "unknown" ? "a" : "b"),
    sha(suffix === "unknown" ? "e" : "f"),
    JSON.stringify(snapshot),
    binding.artifact,
    binding.workflow,
  ]);
  await pool.query(`
    SELECT * FROM release_workflow_review_command(
      $1,$2,'release-checker','approve',$3,$4,CURRENT_TIMESTAMP + interval '30 minutes'
    )
  `, [
    `approval-${environment}-${suffix}`,
    commandId,
    `Approve exact ${environment} worker snapshot`,
    sha(suffix === "unknown" ? "e" : "f"),
  ]);
  return commandId;
}

async function claim(environment, attemptKey, owner) {
  return pool.query(`
    SELECT * FROM release_workflow_claim_next_command_v2(
      $1,$2,300,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb
    )
  `, [
    attemptKey, owner, environment, binding.g7, binding.provider[environment], binding.environment, binding.runner,
    binding.target, binding.receipt, binding.auditor, binding.reviewer,
    JSON.stringify(providerMaterial(environment)),
  ]);
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const options = {
    directory: new URL("../postgres/migrations/", import.meta.url),
    commitSha: "restricted-cicd-t8-1c-worker",
  };
  const migrated = await runPostgresMigrations(pool, options);
  assert.ok(migrated.applied.includes("0079_restricted_cicd_worker_dispatch.sql"));
  assert.ok(migrated.applied.includes("0080_restricted_cicd_provider_reconciliation.sql"));
  const rerun = await runPostgresMigrations(pool, options);
  assert.deepEqual(rerun.applied, []);
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('release-maker','worker-maker@quality.invalid','test-only-hash','hq_admin','active'),
      ('release-checker','worker-checker@quality.invalid','test-only-hash','hq_admin','active'),
      ('security-approver','worker-security@quality.invalid','test-only-hash','hq_admin','active'),
      ('release-approver','worker-release@quality.invalid','test-only-hash','hq_admin','active'),
      ('production-enabler','worker-enabler@quality.invalid','test-only-hash','hq_admin','active');
    INSERT INTO release_versions(
      id,version_tag,channel,commit_sha,artifact_sha256,migration_version,release_notes,reason,
      created_by_user_id,idempotency_key,request_id
    ) VALUES(
      'release-worker','v9.1.0-beta.1','beta',repeat('a',40),repeat('c',64),
      '0079_restricted_cicd_worker_dispatch','Restricted worker fixture release',
      'Create restricted worker fixture','release-maker','release-worker-version-idem','release-worker-version-request'
    );
    INSERT INTO release_verifications(
      id,release_version_id,decision,evidence_sha256,reviewer_user_id,reason,idempotency_key,request_id
    ) VALUES(
      'release-worker-verification','release-worker','approve',repeat('9',64),'release-checker',
      'Verify restricted worker fixture','release-worker-verify-idem','release-worker-verify-request'
    );
  `);
  for (const environment of ["staging", "production"]) {
    await pool.query(
      "SELECT * FROM release_workflow_record_provider_binding($1,$2::jsonb)",
      [binding.provider[environment], JSON.stringify(providerMaterial(environment))],
    );
    await pool.query(`
      SELECT * FROM release_workflow_record_activation(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        'security-approver','release-approver',$13,CURRENT_TIMESTAMP + interval '30 minutes'
      )
    `, [
      `activation-${environment}-worker`, environment, binding.g7, binding.provider[environment],
      binding.artifact, binding.workflow, binding.environment, binding.runner, binding.target,
      binding.receipt, binding.auditor, binding.reviewer,
      `Approve ${environment} restricted worker activation`,
    ]);
  }
  await pool.query(`
    SELECT * FROM release_workflow_record_first_production_enablement(
      'enablement-production-worker','activation-production-worker','production-enabler',repeat('a',64),
      $1,$2,$3,$4,$5,'Explicitly enable production worker fixture',CURRENT_TIMESTAMP + interval '20 minutes'
    )
  `, [binding.g7, binding.provider.production, binding.workflow, binding.target, binding.receipt]);
  await createCommand("staging", "unknown");
  await createCommand("production", "reject");
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

test("claim and begin-dispatch persist the request before an unknown POST outcome blocks retry", async () => {
  const leaseConstraint = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid='release_workflow_attempts'::regclass
       AND conname='release_workflow_attempts_check'
  `);
  assert.match(leaseConstraint.rows[0].definition, /fact_kind <> 'leased'.*lease_expires_at > created_at/i);
  const claimed = await claim("staging", "attempt-staging-unknown", "release-worker-staging");
  assert.equal(claimed.rowCount, 1);
  assert.equal(claimed.rows[0].command_id, "command-staging-unknown");
  assert.equal(claimed.rows[0].activation_id, "activation-staging-worker");
  assert.equal(claimed.rows[0].fencing_token, "1");

  const requestDigest = sha("a");
  const begun = await pool.query(`
    SELECT * FROM release_workflow_begin_dispatch($1,$2,$3,$4)
  `, ["attempt-staging-unknown", "release-worker-staging", 1, requestDigest]);
  assert.deepEqual(begun.rows[0], { dispatch_request_sha256: requestDigest, replayed: false });
  const replay = await pool.query(`
    SELECT * FROM release_workflow_begin_dispatch($1,$2,$3,$4)
  `, ["attempt-staging-unknown", "release-worker-staging", 1, requestDigest]);
  assert.deepEqual(replay.rows[0], { dispatch_request_sha256: requestDigest, replayed: true });

  const unknown = await pool.query(`
    SELECT * FROM release_workflow_record_dispatch_unknown($1,$2,$3,$4,$5)
  `, ["attempt-staging-unknown", "release-worker-staging", 1, requestDigest, "transport_failure"]);
  assert.deepEqual(unknown.rows[0], { recorded: true, provider_run_id: null, replayed: false });
  const unknownReplay = await pool.query(`
    SELECT * FROM release_workflow_record_dispatch_unknown($1,$2,$3,$4,$5)
  `, ["attempt-staging-unknown", "release-worker-staging", 1, requestDigest, "transport_failure"]);
  assert.deepEqual(unknownReplay.rows[0], { recorded: true, provider_run_id: null, replayed: true });

  assert.deepEqual((await pool.query(`
    SELECT status,dispatch_outcome_unknown FROM release_workflow_command_states
     WHERE command_id='command-staging-unknown'
  `)).rows[0], { status: "manual_intervention", dispatch_outcome_unknown: true });
  assert.deepEqual((await pool.query(`
    SELECT blocked,active_attempt_key FROM release_workflow_environment_states WHERE environment='staging'
  `)).rows[0], { blocked: true, active_attempt_key: "attempt-staging-unknown" });
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-staging-unknown','release-worker-staging',1,'7001',
      'https://github.com/agentnovas/platform/actions/runs/7001',$1
    )
  `, [requestDigest]), /dispatch outcome unknown/i);
});

test("an exact run cannot bind before begin-dispatch and a mismatched bound run is terminally quarantined", async () => {
  const claimed = await claim("production", "attempt-production-reject", "release-worker-production");
  assert.equal(claimed.rowCount, 1);
  assert.equal(claimed.rows[0].command_id, "command-production-reject");
  const requestDigest = sha("b");
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-production-reject','release-worker-production',1,'8001',
      'https://github.com/agentnovas/platform/actions/runs/8001',$1
    )
  `, [requestDigest]), /dispatch was not persisted/i);
  await pool.query(`
    SELECT * FROM release_workflow_begin_dispatch(
      'attempt-production-reject','release-worker-production',1,$1
    )
  `, [requestDigest]);
  const bound = await pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-production-reject','release-worker-production',1,'8001',
      'https://github.com/agentnovas/platform/actions/runs/8001',$1
    )
  `, [requestDigest]);
  assert.deepEqual(bound.rows[0], { provider_run_id: "8001", replayed: false });

  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_claim_next_reconciliation_v2($1,$2,$3::jsonb)
  `, ["production", binding.provider.production, JSON.stringify({ ...providerMaterial("production"), workflowId: "99887767" })]), /binding mismatch/i);
  const reconciliation = await pool.query(`
    SELECT * FROM release_workflow_claim_next_reconciliation_v2($1,$2,$3::jsonb)
  `, ["production", binding.provider.production, JSON.stringify(providerMaterial("production"))]);
  assert.deepEqual(reconciliation.rows[0], {
    attempt_key: "attempt-production-reject",
    command_id: "command-production-reject",
    lease_owner: "release-worker-production",
    fencing_token: "1",
    provider_run_id: "8001",
  });
  const queuedAt = new Date("2026-08-27T08:09:10.000Z");
  const queued = await pool.query(`
    SELECT * FROM release_workflow_append_provider_event(
      'provider-queued-production','attempt-production-reject','release-worker-production',1,
      '8001','provider_queued',$1,$2::jsonb,$3
    )
  `, [sha("8"), JSON.stringify({
    runId: "8001",
    runAttempt: 1,
    status: "queued",
    conclusion: null,
    providerUpdatedAt: queuedAt.toISOString(),
  }), queuedAt]);
  assert.deepEqual(queued.rows[0], { event_id: "provider-queued-production", replayed: false });
  assert.equal((await pool.query(`
    SELECT status FROM release_workflow_command_states WHERE command_id='command-production-reject'
  `)).rows[0].status, "dispatch_accepted");

  const completedAt = new Date("2026-08-27T08:10:10.000Z");
  const terminalClient = await pool.connect();
  try {
    await terminalClient.query("BEGIN");
    await terminalClient.query(`
      SELECT * FROM release_workflow_append_provider_event(
        'provider-success-production','attempt-production-reject','release-worker-production',1,
        '8001','completed_success',$1,$2::jsonb,$3
      )
    `, [sha("7"), JSON.stringify({
      runId: "8001",
      runAttempt: 1,
      status: "completed",
      conclusion: "success",
      providerUpdatedAt: completedAt.toISOString(),
    }), completedAt]);
    assert.deepEqual((await terminalClient.query(`
      SELECT status,receipt_missing FROM release_workflow_command_states
       WHERE command_id='command-production-reject'
    `)).rows[0], { status: "settling", receipt_missing: true });
    const terminalReconciliation = await terminalClient.query(`
      SELECT * FROM release_workflow_claim_next_reconciliation_v2($1,$2,$3::jsonb)
    `, ["production", binding.provider.production, JSON.stringify(providerMaterial("production"))]);
    assert.equal(terminalReconciliation.rowCount, 0, "terminal provider facts must not starve future work");
  } finally {
    await terminalClient.query("ROLLBACK").catch(() => undefined);
    terminalClient.release();
  }

  const rejected = await pool.query(`
    SELECT * FROM release_workflow_reject_bound_run(
      'exact-run-rejected-production','attempt-production-reject','release-worker-production',1,
      '8001',$1,'exact_run_mismatch'
    )
  `, [sha("9")]);
  assert.deepEqual(rejected.rows[0], { event_id: "exact-run-rejected-production", replayed: false });
  assert.equal((await pool.query(`
    SELECT status FROM release_workflow_command_states WHERE command_id='command-production-reject'
  `)).rows[0].status, "manual_intervention");
  assert.equal((await pool.query(`
    SELECT blocked FROM release_workflow_environment_states WHERE environment='production'
  `)).rows[0].blocked, true);
  assert.deepEqual((await pool.query(`
    SELECT source,kind,metadata_json FROM release_workflow_events WHERE id='exact-run-rejected-production'
  `)).rows[0], {
    source: "worker",
    kind: "exact_run_rejected",
    metadata_json: { runId: "8001", runAttempt: 1, reasonCode: "exact_run_mismatch" },
  });
});

test("an expired persisted dispatch blocks new claims and is atomically recovered as unknown", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(`
      DELETE FROM release_workflow_attempts
       WHERE attempt_key='attempt-staging-unknown' AND fact_kind='dispatch_unknown';
      UPDATE release_workflow_attempts
         SET created_at=CURRENT_TIMESTAMP-interval '2 minutes',
             lease_expires_at=CURRENT_TIMESTAMP-interval '1 minute'
       WHERE attempt_key='attempt-staging-unknown' AND fact_kind IN ('leased','dispatching');
      UPDATE release_workflow_command_states
         SET status='dispatching',dispatch_outcome_unknown=false
       WHERE command_id='command-staging-unknown';
      UPDATE release_workflow_environment_states
         SET blocked=false
       WHERE environment='staging';
    `);
    await client.query("SET LOCAL session_replication_role=origin");

    const isolatedProductionClaim = await client.query(`
      SELECT * FROM release_workflow_claim_next_command_v2(
        'attempt-production-isolation-probe','release-worker-production-isolation',300,
        'production',$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
      )
    `, [
      binding.g7, binding.provider.production, binding.environment, binding.runner,
      binding.target, binding.receipt, binding.auditor, binding.reviewer,
      JSON.stringify(providerMaterial("production")),
    ]);
    assert.equal(
      isolatedProductionClaim.rowCount,
      0,
      "an expired staging dispatch must not block or leak into a production claim",
    );
    assert.equal(
      (await client.query("SELECT * FROM release_workflow_recover_expired_dispatch_v2('production')")).rowCount,
      0,
      "production recovery must not consume staging uncertainty",
    );

    await client.query("SAVEPOINT rejected_claim");
    await assert.rejects(client.query(`
      SELECT * FROM release_workflow_claim_next_command_v2(
        'attempt-must-not-lease','release-worker-recovery',300,
        'staging',$1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
      )
    `, [
      binding.g7, binding.provider.staging, binding.environment, binding.runner,
      binding.target, binding.receipt, binding.auditor, binding.reviewer,
      JSON.stringify(providerMaterial("staging")),
    ]), /expired dispatch recovery required/i);
    await client.query("ROLLBACK TO SAVEPOINT rejected_claim");

    const recovered = await client.query("SELECT * FROM release_workflow_recover_expired_dispatch_v2('staging')");
    assert.deepEqual(recovered.rows[0], {
      attempt_key: "attempt-staging-unknown",
      command_id: "command-staging-unknown",
    });
    assert.deepEqual((await client.query(`
      SELECT status,dispatch_outcome_unknown FROM release_workflow_command_states
       WHERE command_id='command-staging-unknown'
    `)).rows[0], { status: "manual_intervention", dispatch_outcome_unknown: true });
    assert.equal((await client.query(`
      SELECT outcome_code FROM release_workflow_attempts
       WHERE attempt_key='attempt-staging-unknown' AND fact_kind='dispatch_unknown'
    `)).rows[0].outcome_code, "worker_recovery");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});
