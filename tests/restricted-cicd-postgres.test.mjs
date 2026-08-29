import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `restricted_cicd_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });

const FACT_TABLES = [
  "release_workflow_commands",
  "release_workflow_approvals",
  "release_workflow_activations",
  "release_workflow_provider_bindings",
  "release_workflow_first_production_enablements",
  "release_workflow_environment_generations",
  "release_workflow_attempts",
  "release_workflow_authorizations",
  "release_workflow_target_operations",
  "release_workflow_target_owner_epochs",
  "release_workflow_run_policy_attestations",
  "release_workflow_events",
  "release_workflow_deliveries",
  "release_workflow_receipts",
  "release_workflow_stop_receipts",
  "release_workflow_stops",
  "release_workflow_artifact_manifests",
  "release_workflow_control_bundles",
  "release_workflow_actor_authorities",
  "release_workflow_restore_capabilities",
  "release_workflow_human_action_authorities",
  "release_workflow_human_action_assertions",
  "release_workflow_human_action_assertion_consumptions",
  "release_workflow_command_requests",
  "release_workflow_command_request_reviews",
  "release_workflow_activation_requests",
  "release_workflow_activation_request_reviews",
  "release_workflow_stop_release_requests",
  "release_workflow_stop_release_reviews",
];

const PROJECTION_TABLES = [
  "release_workflow_command_states",
  "release_workflow_environment_states",
];

const sha = (letter) => letter.repeat(64);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fixtureSnapshotExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
const providerMaterial = Object.freeze({
  provider: "github_actions",
  apiVersion: "2026-03-10",
  apiBaseUrl: "https://api.github.com",
  repositoryOwner: "agentnovas",
  repositoryName: "platform",
  repositoryId: "7001",
  appId: "7002",
  installationId: "7003",
  accountId: "7004",
  workflowId: "8001",
  workflowPath: ".github/workflows/restricted-deployment.yml",
  workflowControlRef: "refs/tags/release-control-v1",
  controlCommitSha: "a".repeat(40),
  workflowSha256: sha("d"),
  environment: "staging",
  oidcAudience: "https://deploy.agentnovas.internal",
  runnerEnvironment: "github-hosted",
});

async function requestCommand(overrides = {}) {
  const input = {
    id: "command-staging-1",
    releaseVersionId: "release-next",
    environment: "staging",
    action: "deploy",
    reason: "Request immutable staging deployment",
    makerUserId: "release-maker",
    idempotencyKey: "release-command-idempotency-1",
    canonicalPayloadSha256: sha("a"),
    snapshotSha256: sha("b"),
    artifactManifestSha256: sha("c"),
    workflowSha256: sha("d"),
    environmentGeneration: 1,
    expectedCurrentReleaseVersionId: null,
    ...overrides,
  };
  input.snapshotJson = overrides.snapshotJson ?? {
    schemaVersion: "1",
    commandId: input.id,
    releaseVersionId: input.releaseVersionId,
    environment: input.environment,
    action: input.action,
    artifactManifestSha256: input.artifactManifestSha256,
    workflowSha256: input.workflowSha256,
    environmentGeneration: input.environmentGeneration,
    expectedCurrentReleaseVersionId: input.expectedCurrentReleaseVersionId,
    expiresAt: fixtureSnapshotExpiresAt,
    releaseTag: "v9.0.0-beta.1",
    releaseCommitSha: "a".repeat(40),
    controlCommitSha: "a".repeat(40),
    imageDigests: { client: sha("1"), operations: sha("2"), maintenance: sha("3"), runtime: sha("4") },
    migrationSetSha256: sha("9"),
    migrationVersion: "0083_restricted_cicd_target_authority",
    hasIrreversibleMigrations: false,
  };
  return pool.query(`
    SELECT * FROM release_workflow_request_command(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14
    )
  `, [
    input.id, input.releaseVersionId, input.environment, input.action, input.reason,
    input.makerUserId, input.idempotencyKey, input.canonicalPayloadSha256, input.snapshotSha256,
    JSON.stringify(input.snapshotJson), input.artifactManifestSha256, input.workflowSha256,
    input.environmentGeneration, input.expectedCurrentReleaseVersionId,
  ]);
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const options = {
    directory: new URL("../postgres/migrations/", import.meta.url),
    commitSha: "restricted-cicd-t8-1b-schema",
  };
  const migrated = await runPostgresMigrations(pool, options);
  assert.ok(migrated.applied.includes("0077_restricted_cicd_facts.sql"));
  const rerun = await runPostgresMigrations(pool, options);
  assert.deepEqual(rerun.applied, []);
  assert.ok(rerun.skipped.includes("0077_restricted_cicd_facts.sql"));
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('release-maker','release-maker@quality.invalid','test-only-hash','hq_admin','active'),
      ('release-checker','release-checker@quality.invalid','test-only-hash','hq_admin','active'),
      ('security-approver','security-approver@quality.invalid','test-only-hash','hq_admin','active'),
      ('release-approver','release-approver@quality.invalid','test-only-hash','hq_admin','active'),
      ('production-enabler','production-enabler@quality.invalid','test-only-hash','hq_admin','active');
    INSERT INTO release_versions(
      id,version_tag,channel,commit_sha,artifact_sha256,migration_version,release_notes,reason,
      created_by_user_id,idempotency_key,request_id
    ) VALUES
      ('release-next','v9.0.0-beta.1','beta',repeat('a',40),repeat('c',64),'0077_restricted_cicd_facts',
       'Restricted CI/CD database fixture release','Create database fixture release','release-maker',
       'release-fixture-idempotency','release-fixture-request');
    INSERT INTO release_verifications(
      id,release_version_id,decision,evidence_sha256,reviewer_user_id,reason,idempotency_key,request_id
    ) VALUES(
      'release-next-verification','release-next','approve',repeat('f',64),'release-checker',
      'Independent release evidence verified','release-verification-idempotency','release-verification-request'
    );
  `);
  await pool.query(
    "SELECT * FROM release_workflow_record_provider_binding($1,$2::jsonb)",
    [sha("2"), JSON.stringify(providerMaterial)],
  );
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

test("0077 creates the complete restricted CI/CD fact and projection boundary", async () => {
  const expected = [...FACT_TABLES, ...PROJECTION_TABLES].sort();
  const tables = await pool.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema=current_schema()
       AND table_name LIKE 'release_workflow_%'
       AND table_type='BASE TABLE'
     ORDER BY table_name
  `);
  assert.deepEqual(tables.rows.map((row) => row.table_name), expected);

  const rls = await pool.query(`
    SELECT relname,relrowsecurity
      FROM pg_class
     WHERE relnamespace=current_schema()::regnamespace
       AND relname=ANY($1::text[])
     ORDER BY relname
  `, [expected]);
  assert.equal(rls.rowCount, expected.length);
  assert.ok(rls.rows.every((row) => row.relrowsecurity === true));

  const publicGrants = await pool.query(`
    SELECT table_name,privilege_type
      FROM information_schema.role_table_grants
     WHERE table_schema=current_schema()
       AND table_name=ANY($1::text[])
       AND grantee='PUBLIC'
  `, [expected]);
  assert.deepEqual(publicGrants.rows, []);

  const safeView = await pool.query(`
    SELECT table_name
      FROM information_schema.views
     WHERE table_schema=current_schema() AND table_name='release_workflow_safe_status'
  `);
  assert.deepEqual(safeView.rows, [{ table_name: "release_workflow_safe_status" }]);
  const safeViewColumns = await pool.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name='release_workflow_safe_status'
  `);
  for (const forbidden of ["snapshot_json", "signature", "authorization_nonce", "oidc_jti_sha256"]) {
    assert.equal(safeViewColumns.rows.some((row) => row.column_name === forbidden), false, forbidden);
  }
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count
      FROM information_schema.role_table_grants
     WHERE table_schema=current_schema()
       AND table_name='release_workflow_safe_status'
       AND grantee='PUBLIC'
  `)).rows[0].count, 0);
});

test("all restricted CI/CD fact tables reject UPDATE and DELETE", async () => {
  const protectedTables = await pool.query(`
    SELECT event_object_table,event_manipulation
      FROM information_schema.triggers
     WHERE trigger_schema=current_schema()
       AND action_statement='EXECUTE FUNCTION protect_release_workflow_fact_immutable()'
     ORDER BY event_object_table,event_manipulation
  `);
  assert.deepEqual(
    protectedTables.rows,
    FACT_TABLES.flatMap((tableName) => [
      { event_object_table: tableName, event_manipulation: "DELETE" },
      { event_object_table: tableName, event_manipulation: "UPDATE" },
    ]).sort((left, right) => (
      left.event_object_table.localeCompare(right.event_object_table)
      || left.event_manipulation.localeCompare(right.event_manipulation)
    )),
  );
});

test("command request is generation-bound, concurrent-idempotent, and collision safe", async () => {
  const [first, replay] = await Promise.all([requestCommand(), requestCommand()]);
  assert.deepEqual(
    [first.rows[0], replay.rows[0]].sort((left, right) => Number(left.replayed) - Number(right.replayed)),
    [
      { command_id: "command-staging-1", replayed: false },
      { command_id: "command-staging-1", replayed: true },
    ],
  );
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM release_workflow_commands`)).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-staging-1'`)).rows[0].status, "requested");

  await assert.rejects(
    requestCommand({ snapshotSha256: sha("e") }),
    /idempotency payload mismatch/i,
  );
  await assert.rejects(
    requestCommand({ id: "command-stale-generation", idempotencyKey: "release-command-idempotency-2", environmentGeneration: 2 }),
    /environment snapshot stale/i,
  );
});

test("approval rejects self review and snapshot drift before recording one immutable decision", async () => {
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-self','command-staging-1','release-maker','approve',
      'Maker cannot approve the release command',repeat('b',64),CURRENT_TIMESTAMP + interval '15 minutes'
    )
  `), /self approval forbidden/i);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-drift','command-staging-1','release-checker','approve',
      'Snapshot drift must fail closed',repeat('e',64),CURRENT_TIMESTAMP + interval '15 minutes'
    )
  `), /snapshot mismatch/i);

  const approved = await pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-staging-1','command-staging-1','release-checker','approve',
      'Independent checker approved exact snapshot',repeat('b',64),CURRENT_TIMESTAMP + interval '15 minutes'
    )
  `);
  assert.deepEqual(approved.rows[0], { approval_id: "approval-staging-1", replayed: false });
  const replay = await pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-staging-1','command-staging-1','release-checker','approve',
      'Independent checker approved exact snapshot',repeat('b',64),
      (SELECT expires_at FROM release_workflow_approvals WHERE id='approval-staging-1')
    )
  `);
  assert.deepEqual(replay.rows[0], { approval_id: "approval-staging-1", replayed: true });
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-staging-1'`)).rows[0].status, "approved");
});

test("activation is dual-control and first production enablement binds its exact trust context", async () => {
  const activationArguments = [
    "activation-production-1", "production", sha("1"), sha("2"), sha("c"), sha("d"), sha("3"), sha("4"),
    sha("5"), sha("6"), sha("7"), sha("8"), "security-approver", "release-approver",
    "Security and release independently approved G7", new Date(Date.now() + 30 * 60_000),
  ];
  const selfApprovedActivationArguments = [...activationArguments];
  selfApprovedActivationArguments[13] = selfApprovedActivationArguments[12];
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_record_activation(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
    )
  `, selfApprovedActivationArguments), /dual control required/i);
  const activation = await pool.query(`
    SELECT * FROM release_workflow_record_activation(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
    )
  `, activationArguments);
  assert.deepEqual(activation.rows[0], { activation_id: "activation-production-1", replayed: false });

  const enablement = await pool.query(`
    SELECT * FROM release_workflow_record_first_production_enablement(
      'production-enablement-1','activation-production-1','production-enabler',repeat('9',64),
      repeat('1',64),repeat('2',64),repeat('d',64),repeat('5',64),repeat('6',64),
      'User explicitly enabled first production release',CURRENT_TIMESTAMP + interval '20 minutes'
    )
  `);
  assert.deepEqual(enablement.rows[0], { enablement_id: "production-enablement-1", replayed: false });
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_record_first_production_enablement(
      'production-enablement-drift','activation-production-1','production-enabler',repeat('9',64),
      repeat('1',64),repeat('2',64),repeat('e',64),repeat('5',64),repeat('6',64),
      'Workflow trust drift must fail closed',CURRENT_TIMESTAMP + interval '20 minutes'
    )
  `), /activation binding mismatch/i);
});

test("lease serializes one active attempt and bind-run rejects stale fences and unsafe URLs", async () => {
  await pool.query(`
    SELECT * FROM release_workflow_record_activation(
      'activation-staging-1','staging',repeat('1',64),repeat('2',64),repeat('c',64),repeat('d',64),
      repeat('3',64),repeat('4',64),repeat('5',64),repeat('6',64),repeat('7',64),repeat('8',64),
      'security-approver','release-approver','Independent staging activation approval',
      CURRENT_TIMESTAMP + interval '30 minutes'
    )
  `);

  const lease = () => pool.query(`
    SELECT * FROM release_workflow_lease_command(
      'attempt-staging-1','command-staging-1','release-worker-1',300,'activation-staging-1',
      repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),
      repeat('6',64),repeat('7',64),repeat('8',64)
    )
  `);
  const leases = await Promise.all([lease(), lease()]);
  assert.deepEqual(leases.map((result) => result.rows[0].replayed).sort(), [false, true]);
  assert.ok(leases.every((result) => result.rows[0].fencing_token === "1"));
  assert.equal((await pool.query(`SELECT active_attempt_key FROM release_workflow_environment_states WHERE environment='staging'`)).rows[0].active_attempt_key, "attempt-staging-1");
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-staging-1'`)).rows[0].status, "leased");

  await requestCommand({
    id: "command-staging-2",
    idempotencyKey: "release-command-idempotency-2",
    canonicalPayloadSha256: sha("e"),
    snapshotSha256: sha("f"),
  });
  await pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-staging-2','command-staging-2','release-checker','approve',
      'Independent checker approved second snapshot',repeat('f',64),
      CURRENT_TIMESTAMP + interval '15 minutes'
    )
  `);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_lease_command(
      'attempt-staging-2','command-staging-2','release-worker-2',300,'activation-staging-1',
      repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),
      repeat('6',64),repeat('7',64),repeat('8',64)
    )
  `), /active lease exists/i);
  await pool.query(`
    SELECT * FROM release_workflow_begin_dispatch(
      'attempt-staging-1','release-worker-1',1,repeat('9',64)
    )
  `);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-staging-1','release-worker-1',2,'9001',
      'https://github.com/agentnovas/platform/actions/runs/9001',repeat('9',64)
    )
  `), /stale lease fence/i);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-staging-1','release-worker-1',1,'9001',
      'https://evil.invalid/actions/runs/9001',repeat('9',64)
    )
  `), /provider run url mismatch/i);

  const bound = await pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-staging-1','release-worker-1',1,'9001',
      'https://github.com/agentnovas/platform/actions/runs/9001',repeat('9',64)
    )
  `);
  assert.deepEqual(bound.rows[0], { provider_run_id: "9001", replayed: false });
  const rebound = await pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-staging-1','release-worker-1',1,'9001',
      'https://github.com/agentnovas/platform/actions/runs/9001',repeat('9',64)
    )
  `);
  assert.deepEqual(rebound.rows[0], { provider_run_id: "9001", replayed: true });
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-staging-1'`)).rows[0].status, "dispatch_accepted");

  const heartbeatAt = new Date();
  const heartbeat = await pool.query(`
    SELECT * FROM release_workflow_worker_heartbeat(
      'heartbeat-staging-1','attempt-staging-1','release-worker-1',1,repeat('a',64),$1
    )
  `, [heartbeatAt]);
  assert.deepEqual(heartbeat.rows[0], { event_id: "heartbeat-staging-1", replayed: false });
  const heartbeatReplay = await pool.query(`
    SELECT * FROM release_workflow_worker_heartbeat(
      'heartbeat-staging-1','attempt-staging-1','release-worker-1',1,repeat('a',64),$1
    )
  `, [heartbeatAt]);
  assert.deepEqual(heartbeatReplay.rows[0], { event_id: "heartbeat-staging-1", replayed: true });
});

test("ingress delivery and auditor attestation gateways are append-only and collision safe", async () => {
  const delivery = await pool.query(`
    SELECT * FROM release_workflow_append_delivery(
      'delivery-00000001','workflow_run','in_progress','7001','8001','9001',1,
      repeat('a',40),'refs/tags/release-control','in_progress',NULL,repeat('b',64),1024
    )
  `);
  assert.deepEqual(delivery.rows[0], { delivery_id: "delivery-00000001", replayed: false });
  const deliveryReplay = await pool.query(`
    SELECT * FROM release_workflow_append_delivery(
      'delivery-00000001','workflow_run','in_progress','7001','8001','9001',1,
      repeat('a',40),'refs/tags/release-control','in_progress',NULL,repeat('b',64),1024
    )
  `);
  assert.deepEqual(deliveryReplay.rows[0], { delivery_id: "delivery-00000001", replayed: true });
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_append_delivery(
      'delivery-00000001','workflow_run','in_progress','7001','8001','9001',1,
      repeat('a',40),'refs/tags/release-control','in_progress',NULL,repeat('c',64),1024
    )
  `), /delivery replay mismatch/i);

  const attestationExpiry = new Date(Date.now() + 10 * 60_000);
  const attestationArguments = [
    "attestation-staging-1", "7001", "8001", "9001", 1, "9101", "staging",
    sha("3"), sha("4"), sha("a"), sha("b"), "auditor-nonce-0001", "auditor-key-1",
    "ed25519-signature-test-only", attestationExpiry,
  ];
  const attestation = await pool.query(`
    SELECT * FROM release_workflow_append_run_policy_attestation(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
    )
  `, attestationArguments);
  assert.deepEqual(attestation.rows[0], { attestation_id: "attestation-staging-1", replayed: false });
  const attestationReplay = await pool.query(`
    SELECT * FROM release_workflow_append_run_policy_attestation(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
    )
  `, attestationArguments);
  assert.deepEqual(attestationReplay.rows[0], { attestation_id: "attestation-staging-1", replayed: true });
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_append_run_policy_attestation(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
    )
  `, [...attestationArguments.slice(0, 13), "different-signature-test-only", attestationExpiry]), /attestation replay mismatch/i);
});

test("workflow target reservation derives all privileged identifiers from exact run and OIDC facts", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SAVEPOINT invalid_auditor_trust");
    await assert.rejects(client.query(`
      SELECT * FROM release_workflow_reserve_workflow_target_request_v4(
        'command-staging-1','release-next','9001','9101','staging','deploy',repeat('c',64),1,
        repeat('a',40),repeat('b',64),repeat('6',64),repeat('7',64),repeat('5',64),repeat('6',64),
        repeat('8',64)
      )
    `), /auditor trust mismatch/i);
    await client.query("ROLLBACK TO SAVEPOINT invalid_auditor_trust");
    const reserve = () => client.query(`
      SELECT * FROM release_workflow_reserve_workflow_target_request_v4(
        'command-staging-1','release-next','9001','9101','staging','deploy',repeat('c',64),1,
        repeat('a',40),repeat('b',64),repeat('6',64),repeat('7',64),repeat('5',64),repeat('6',64),
        repeat('7',64)
      )
    `);
    const identityDigest = digest([
      "restricted-cicd-workflow-target-v3", "command-staging-1", "9001", "9101", sha("b"),
    ].join("\x1f"));
    const operationId = `operation-v3-${identityDigest.slice(0, 48)}`;
    const first = await reserve();
    const replay = await reserve();
    assert.deepEqual(first.rows[0], {
      operation_id: operationId,
      owner_epoch: "1",
      replayed: false,
      execution_snapshot: first.rows[0].execution_snapshot,
    });
    assert.equal(first.rows[0].execution_snapshot.commandId, "command-staging-1");
    assert.deepEqual(replay.rows[0], { ...first.rows[0], replayed: true });
    assert.equal((await client.query(`
      SELECT id FROM release_workflow_authorizations WHERE command_id='command-staging-1'
    `)).rows[0].id, `authorization-v3-${identityDigest.slice(0, 48)}`);
    await assert.rejects(client.query(`
      SELECT * FROM release_workflow_reserve_workflow_target_request_v4(
        'command-staging-1','release-next','9001','9102','staging','deploy',repeat('c',64),1,
        repeat('a',40),repeat('b',64),repeat('6',64),repeat('7',64),repeat('5',64),repeat('6',64),
        repeat('7',64)
      )
    `), /attestation unavailable/i);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("target reservation atomically consumes the exact run attestation and cannot mint a second operation", async () => {
  const reservationExpiry = new Date(Date.now() + 4 * 60_000);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_reserve_exact_target_request_v2(
      'authorization-staging-wrong-trust','operation-staging-wrong-trust','command-staging-1','attempt-staging-1',
      'attestation-staging-1','9001','staging','deploy',repeat('b',64),repeat('c',64),repeat('d',64),
      1,NULL,repeat('b',64),'authorization-nonce-wrong-trust',repeat('6',64),repeat('7',64),
      repeat('a',64),repeat('6',64),$1
    )
  `, [reservationExpiry]), /target local trust does not match activation/i);
  const reserve = () => pool.query(`
    SELECT * FROM release_workflow_reserve_exact_target_request_v2(
      'authorization-staging-1','operation-staging-1','command-staging-1','attempt-staging-1',
      'attestation-staging-1','9001','staging','deploy',repeat('b',64),repeat('c',64),repeat('d',64),
      1,NULL,repeat('b',64),'authorization-nonce-0001',repeat('6',64),repeat('7',64),
      repeat('5',64),repeat('6',64),$1
    )
  `, [reservationExpiry]);
  const reservations = await Promise.all([reserve(), reserve()]);
  assert.deepEqual(reservations.map((result) => result.rows[0].replayed).sort(), [false, true]);
  assert.ok(reservations.every((result) => result.rows[0].owner_epoch === "1"));
  assert.ok(reservations.every((result) => result.rows[0].execution_snapshot.commandId === "command-staging-1"));
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM release_workflow_authorizations`)).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM release_workflow_target_operations`)).rows[0].count, 1);
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-staging-1'`)).rows[0].status, "running");
  assert.deepEqual((await pool.query(`
    SELECT active_operation_id,target_owner_epoch
      FROM release_workflow_environment_states
     WHERE environment='staging'
  `)).rows[0], { active_operation_id: "operation-staging-1", target_owner_epoch: "1" });
  assert.deepEqual((await pool.query(`
    SELECT * FROM release_workflow_list_recoverable_target_operations_v2(
      'staging',repeat('6',64),repeat('5',64),repeat('6',64)
    )
  `)).rows, [{ operation_id: "operation-staging-1", command_id: "command-staging-1" }]);

  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_reserve_exact_target_request_v2(
      'authorization-staging-2','operation-staging-2','command-staging-1','attempt-staging-1',
      'attestation-staging-1','9001','staging','deploy',repeat('b',64),repeat('c',64),repeat('d',64),
      1,NULL,repeat('b',64),'authorization-nonce-0002',repeat('6',64),repeat('7',64),
      repeat('5',64),repeat('6',64),$1
    )
  `, [reservationExpiry]), /operation replay mismatch/i);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_reserve_exact_target_request_v2(
      'authorization-staging-3','operation-staging-3','command-staging-2','attempt-staging-1',
      'attestation-staging-1','9001','staging','deploy',repeat('f',64),repeat('c',64),repeat('d',64),
      1,NULL,repeat('b',64),'authorization-nonce-0003',repeat('6',64),repeat('7',64),
      repeat('5',64),repeat('6',64),$1
    )
  `, [reservationExpiry]), /target request run binding mismatch/i);

  const backupId = "backup-operation-staging-1";
  const backupSha256 = sha("1");
  const restoreTocSha256 = sha("2");
  const restorePlanSha256 = digest([
    "restricted-cicd-restore-plan-v1", "operation-staging-1", "release-next", "", "1",
    sha("9"), "0083_restricted_cicd_target_authority", backupId, backupSha256,
    restoreTocSha256, "pg_restore-list-v1",
  ].join("\x1f"));
  const cutoverFence = await pool.query(`
    SELECT * FROM release_workflow_validate_target_cutover_v2(
      'operation-staging-1',1,repeat('b',64),1,NULL,repeat('5',64),repeat('6',64),
      $1,$2,$3,$4,CURRENT_TIMESTAMP
    )
  `, [backupId, backupSha256, restoreTocSha256, restorePlanSha256]);
  assert.equal(cutoverFence.rows[0].release_version_id, "release-next");
  assert.ok(cutoverFence.rows[0].validated_at instanceof Date);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_validate_target_cutover_v2(
      'operation-staging-1',2,repeat('b',64),1,NULL,repeat('5',64),repeat('6',64),
      $1,$2,$3,$4,CURRENT_TIMESTAMP
    )
  `, [backupId, backupSha256, restoreTocSha256, restorePlanSha256]), /target cutover fence stale/i);

  const registryDigest = await pool.query(`
    SELECT encode(sha256(convert_to(
      COALESCE(string_agg(name || ':' || checksum,E'\\n' ORDER BY name),''),'UTF8'
    )),'hex') AS sha256
      FROM _agentnovas_migrations
  `);
  const registry = await pool.query(
    "SELECT * FROM release_workflow_assert_migration_registry($1)",
    [registryDigest.rows[0].sha256],
  );
  assert.equal(registry.rows[0].migration_registry_sha256, registryDigest.rows[0].sha256);
  assert.ok(Number(registry.rows[0].migration_count) >= 82);
  await assert.rejects(
    pool.query("SELECT * FROM release_workflow_assert_migration_registry($1)", [sha("f")]),
    /migration registry mismatch/i,
  );
});

test("target receipt is owner-fenced and remains authoritative over a late provider failure", async () => {
  const takeover = await pool.query(`
    SELECT * FROM release_workflow_takeover_target_operation(
      'target-owner-staging-2','operation-staging-1',1,2,repeat('e',64),repeat('f',64),
      'Target recovered ownership after the original owner stopped'
    )
  `);
  assert.deepEqual(takeover.rows[0], { owner_epoch: "2", replayed: false });
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_reserve_exact_run_operation(
      'authorization-staging-1','operation-staging-1','command-staging-1','attempt-staging-1',
      'attestation-staging-1',repeat('b',64),'authorization-nonce-0001',repeat('6',64),repeat('7',64),
      (SELECT expires_at FROM release_workflow_authorizations WHERE id='authorization-staging-1')
    )
  `), /stale target owner epoch/i);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_takeover_target_operation(
      'target-owner-staging-3','operation-staging-1',1,3,repeat('1',64),repeat('2',64),
      'Stale target owner cannot skip the current epoch'
    )
  `), /stale target owner epoch/i);

  const secondTakeover = await pool.query(`
    SELECT * FROM release_workflow_takeover_target_operation(
      'target-owner-staging-3','operation-staging-1',2,3,repeat('1',64),repeat('2',64),
      'A second recovered owner takes the current target epoch'
    )
  `);
  assert.deepEqual(secondTakeover.rows[0], { owner_epoch: "3", replayed: false });
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_takeover_target_operation(
      'target-owner-staging-2','operation-staging-1',1,2,repeat('e',64),repeat('f',64),
      'Target recovered ownership after the original owner stopped'
    )
  `), /stale target owner epoch/i);

  const uncertainClient = await pool.connect();
  try {
    await uncertainClient.query("BEGIN");
    await uncertainClient.query("SAVEPOINT terminal_phase_case");
    const uncertainPayload = {
      schemaVersion: "1",
      operationId: "operation-staging-1",
      commandId: "command-staging-1",
      phase: "uncertain_before_cutover",
      ownerEpoch: 3,
      journalSequence: 1,
      actualPreviousReleaseVersionId: null,
      actualCurrentReleaseVersionId: null,
    };
    await uncertainClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-staging-uncertain-before','operation-staging-1','receipt-nonce-uncertain-before',
        'target-key-1',$1::jsonb,repeat('8',64),'target-signature-uncertain-before',
        'uncertain_before_cutover',3,1,NULL,NULL,true
      )
    `, [JSON.stringify(uncertainPayload)]);
    assert.deepEqual((await uncertainClient.query(`
      SELECT command.status,environment.blocked
        FROM release_workflow_command_states AS command
        JOIN release_workflow_environment_states AS environment ON environment.environment='staging'
       WHERE command.command_id='command-staging-1'
    `)).rows[0], { status: "manual_intervention", blocked: true });
    await uncertainClient.query("SAVEPOINT expected_rejection");
    await assert.rejects(uncertainClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-staging-after-uncertain','operation-staging-1','receipt-nonce-after-uncertain',
        'target-key-1',
        '{"schemaVersion":"1","operationId":"operation-staging-1","commandId":"command-staging-1","phase":"cutover_committed","ownerEpoch":3,"journalSequence":2,"actualPreviousReleaseVersionId":null,"actualCurrentReleaseVersionId":"release-next"}'::jsonb,
        repeat('9',64),'target-signature-after-uncertain','cutover_committed',3,2,NULL,
        'release-next',true
      )
    `), /terminal target receipt phase/i);
    await uncertainClient.query("ROLLBACK TO SAVEPOINT expected_rejection");
    await assert.rejects(uncertainClient.query(`
      SELECT * FROM release_workflow_takeover_target_operation(
        'target-owner-after-uncertain-before','operation-staging-1',3,4,repeat('3',64),repeat('4',64),
        'A terminal uncertain receipt must refuse new deployment ownership'
      )
    `), /target operation terminal/i);
    await uncertainClient.query("ROLLBACK TO SAVEPOINT expected_rejection");

    await uncertainClient.query("ROLLBACK TO SAVEPOINT terminal_phase_case");
    await uncertainClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-staging-failed-before','operation-staging-1','receipt-nonce-failed-before',
        'target-key-1',
        '{"schemaVersion":"1","operationId":"operation-staging-1","commandId":"command-staging-1","phase":"failed_before_cutover","ownerEpoch":3,"journalSequence":1,"actualPreviousReleaseVersionId":null,"actualCurrentReleaseVersionId":null}'::jsonb,
        repeat('5',64),'target-signature-failed-before','failed_before_cutover',3,1,NULL,NULL,true
      )
    `);
    await uncertainClient.query("SAVEPOINT expected_rejection");
    await assert.rejects(uncertainClient.query(`
      SELECT * FROM release_workflow_takeover_target_operation(
        'target-owner-after-failed-before','operation-staging-1',3,4,repeat('3',64),repeat('4',64),
        'A terminal failed receipt must refuse new deployment ownership'
      )
    `), /target operation terminal/i);
    await uncertainClient.query("ROLLBACK TO SAVEPOINT expected_rejection");

    await uncertainClient.query("ROLLBACK TO SAVEPOINT terminal_phase_case");
    await uncertainClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-staging-stop-committed','operation-staging-1','receipt-nonce-stop-committed',
        'target-key-1',
        '{"schemaVersion":"1","operationId":"operation-staging-1","commandId":"command-staging-1","phase":"stop_committed","ownerEpoch":3,"journalSequence":1,"actualPreviousReleaseVersionId":null,"actualCurrentReleaseVersionId":null}'::jsonb,
        repeat('6',64),'target-signature-stop-committed','stop_committed',3,1,NULL,NULL,true
      )
    `);
    await uncertainClient.query("SAVEPOINT expected_rejection");
    await assert.rejects(uncertainClient.query(`
      SELECT * FROM release_workflow_takeover_target_operation(
        'target-owner-after-stop-committed','operation-staging-1',3,4,repeat('3',64),repeat('4',64),
        'A terminal stop receipt must refuse new deployment ownership'
      )
    `), /target operation terminal/i);
  } finally {
    await uncertainClient.query("ROLLBACK");
    uncertainClient.release();
  }

  const healthPayload = {
    schemaVersion: "1",
    operationId: "operation-staging-1",
    commandId: "command-staging-1",
    phase: "health_verified",
    ownerEpoch: 3,
    journalSequence: 5,
    actualPreviousReleaseVersionId: null,
    actualCurrentReleaseVersionId: "release-next",
    releaseVersionId: "release-next",
    artifactManifestSha256: sha("c"),
    imageDigests: { client: sha("1"), operations: sha("2"), maintenance: sha("3"), runtime: sha("4") },
    migrationRegistrySha256: sha("9"),
    completedAt: new Date().toISOString(),
  };
  const healthArguments = [
    "receipt-staging-health", "operation-staging-1", "receipt-nonce-health", "target-key-1",
    JSON.stringify(healthPayload), sha("c"), "target-signature-health", "health_verified",
    3, 5, null, "release-next", true,
  ];
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13
    )
  `, [...healthArguments.slice(0, 8), 2, ...healthArguments.slice(9)]), /stale owner epoch/i);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13
    )
  `, [
    "receipt-staging-health-early", "operation-staging-1", "receipt-nonce-health-early-staging",
    "target-key-1", JSON.stringify({ ...healthPayload, journalSequence: 1 }), sha("b"),
    "target-signature-health-early-staging", "health_verified", 3, 1, null, "release-next", true,
  ]), /target receipt phase transition invalid/i);

  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_append_provider_event(
      'provider-event-wrong-run','attempt-staging-1','release-worker-1',1,'9999',
      'completed_failure',repeat('d',64),'{"runId":"9999","runAttempt":1,"conclusion":"failure"}'::jsonb,
      CURRENT_TIMESTAMP
    )
  `), /provider run mismatch/i);
  const providerFailure = await pool.query(`
    SELECT * FROM release_workflow_append_provider_event(
      'provider-event-staging-failed','attempt-staging-1','release-worker-1',1,'9001',
      'completed_failure',repeat('d',64),'{"runId":"9001","runAttempt":1,"conclusion":"failure"}'::jsonb,
      CURRENT_TIMESTAMP
    )
  `);
  assert.deepEqual(providerFailure.rows[0], { event_id: "provider-event-staging-failed", replayed: false });
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-staging-1'`)).rows[0].status, "settling");
  assert.equal((await pool.query(`SELECT active_operation_id FROM release_workflow_environment_states WHERE environment='staging'`)).rows[0].active_operation_id, "operation-staging-1");

  const cutoverPayload = {
    ...healthPayload,
    phase: "cutover_committed",
    journalSequence: 4,
  };
  const cutover = await pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13
    )
  `, [
    "receipt-staging-cutover", "operation-staging-1", "receipt-nonce-cutover", "target-key-1",
    JSON.stringify(cutoverPayload), sha("d"), "target-signature-cutover", "cutover_committed",
    3, 4, null, "release-next", true,
  ]);
  assert.deepEqual(cutover.rows[0], { receipt_id: "receipt-staging-cutover", replayed: false });
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      'receipt-staging-downgrade','operation-staging-1','receipt-nonce-downgrade','target-key-1',
      '{"schemaVersion":"1","operationId":"operation-staging-1","commandId":"command-staging-1","phase":"failed_before_cutover","ownerEpoch":3,"journalSequence":5,"actualPreviousReleaseVersionId":null,"actualCurrentReleaseVersionId":null}'::jsonb,
      repeat('e',64),'target-signature-downgrade','failed_before_cutover',3,5,NULL,NULL,true
    )
  `), /target receipt phase transition invalid/i);

  const health = await pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13
    )
  `, healthArguments);
  assert.deepEqual(health.rows[0], { receipt_id: "receipt-staging-health", replayed: false });
  const healthReplay = await pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13
    )
  `, healthArguments);
  assert.deepEqual(healthReplay.rows[0], { receipt_id: "receipt-staging-health", replayed: true });
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-staging-1'`)).rows[0].status, "deployed_reconciliation_required");
  const stagingState = (await pool.query(`SELECT expected_current_release_version_id,blocked FROM release_workflow_environment_states WHERE environment='staging'`)).rows[0];
  assert.deepEqual(stagingState, { expected_current_release_version_id: "release-next", blocked: true });
  assert.deepEqual((await pool.query(`
    SELECT * FROM release_workflow_list_recoverable_target_operations_v2(
      'staging',repeat('3',64),repeat('5',64),repeat('6',64)
    )
  `)).rows, []);
});

test("target recomputes production staging and rollback history prerequisites", async () => {
  const productionSnapshot = {
    schemaVersion: "1", commandId: "command-production-prerequisite", releaseVersionId: "release-next",
    environment: "production", action: "deploy", migrationSetSha256: sha("9"),
    migrationVersion: "0083_restricted_cicd_target_authority",
    releaseTag: "v9.0.0-beta.1", releaseCommitSha: "a".repeat(40),
    imageDigests: { client: sha("1"), operations: sha("2"), maintenance: sha("3"), runtime: sha("4") },
    hasIrreversibleMigrations: false, stagingReceiptSha256: sha("c"),
    expiresAt: fixtureSnapshotExpiresAt,
  };
  await pool.query(`
    INSERT INTO release_workflow_commands(
      id,release_version_id,environment,action,reason,maker_user_id,idempotency_key,
      canonical_payload_sha256,snapshot_sha256,snapshot_json,artifact_manifest_sha256,
      workflow_sha256,environment_generation,expected_current_release_version_id
    ) VALUES($1,'release-next','production','deploy',$2,'release-maker',$3,$4,$5,$6::jsonb,
      repeat('c',64),repeat('d',64),1,NULL)
  `, [
    productionSnapshot.commandId, "Production prerequisite recomputation fixture",
    "production-prerequisite-idempotency", digest("production-prerequisite-payload"),
    digest("production-prerequisite-snapshot"), JSON.stringify(productionSnapshot),
  ]);
  await pool.query(`
    INSERT INTO release_workflow_attempts(
      id,attempt_key,command_id,activation_id,environment,fact_kind,lease_owner,fencing_token,
      environment_generation,snapshot_sha256,lease_expires_at,provider_run_id,provider_run_attempt
    ) VALUES($1,$2,$3,'activation-production-1','production','run_bound','fixture-worker',1,1,$4,
      CURRENT_TIMESTAMP + interval '10 minutes','9301',1)
  `, [
    "attempt-production-prerequisite-run", "attempt-production-prerequisite",
    productionSnapshot.commandId, digest("production-prerequisite-snapshot"),
  ]);
  await pool.query(
    "SELECT release_workflow_assert_target_prerequisites($1,$2,$3)",
    [productionSnapshot.commandId, sha("5"), sha("6")],
  );
  const staleSignedEvidence = await pool.connect();
  try {
    await staleSignedEvidence.query("BEGIN");
    await staleSignedEvidence.query(
      "ALTER TABLE release_workflow_receipts DISABLE TRIGGER trg_release_workflow_receipts_immutable",
    );
    await staleSignedEvidence.query(`
      UPDATE release_workflow_receipts
         SET payload_json=jsonb_set(payload_json,'{completedAt}',to_jsonb($1::text))
       WHERE id='receipt-staging-health'
    `, [new Date(Date.now() - 25 * 60 * 60_000).toISOString()]);
    await assert.rejects(staleSignedEvidence.query(
      "SELECT release_workflow_assert_target_prerequisites($1,$2,$3)",
      [productionSnapshot.commandId, sha("5"), sha("6")],
    ), /same artifact staging receipt unavailable/i);
  } finally {
    await staleSignedEvidence.query("ROLLBACK");
    staleSignedEvidence.release();
  }

  const badProductionSnapshot = {
    ...productionSnapshot,
    commandId: "command-production-prerequisite-bad",
    imageDigests: { ...productionSnapshot.imageDigests, runtime: sha("e") },
  };
  await pool.query(`
    INSERT INTO release_workflow_commands(
      id,release_version_id,environment,action,reason,maker_user_id,idempotency_key,
      canonical_payload_sha256,snapshot_sha256,snapshot_json,artifact_manifest_sha256,
      workflow_sha256,environment_generation,expected_current_release_version_id
    ) VALUES($1,'release-next','production','deploy',$2,'release-maker',$3,$4,$5,$6::jsonb,
      repeat('c',64),repeat('d',64),1,NULL)
  `, [
    badProductionSnapshot.commandId, "Mismatched production image digest fixture",
    "production-prerequisite-bad-idempotency", digest("production-prerequisite-bad-payload"),
    digest("production-prerequisite-bad-snapshot"), JSON.stringify(badProductionSnapshot),
  ]);
  await pool.query(`
    INSERT INTO release_workflow_attempts(
      id,attempt_key,command_id,activation_id,environment,fact_kind,lease_owner,fencing_token,
      environment_generation,snapshot_sha256,lease_expires_at,provider_run_id,provider_run_attempt
    ) VALUES($1,$2,$3,'activation-production-1','production','run_bound','fixture-worker',1,1,$4,
      CURRENT_TIMESTAMP + interval '10 minutes','9302',1)
  `, [
    "attempt-production-prerequisite-bad-run", "attempt-production-prerequisite-bad",
    badProductionSnapshot.commandId, digest("production-prerequisite-bad-snapshot"),
  ]);
  await assert.rejects(pool.query(
    "SELECT release_workflow_assert_target_prerequisites($1,$2,$3)",
    [badProductionSnapshot.commandId, sha("5"), sha("6")],
  ), /same artifact staging receipt unavailable/i);

  const oldReleaseId = "release-old-target";
  const oldCommandId = "command-old-target-history";
  const oldOperationId = "operation-old-target-history";
  const oldReceiptSha256 = digest("old-target-health-receipt");
  const oldImageDigests = {
    client: sha("5"), operations: sha("6"), maintenance: sha("7"), runtime: sha("8"),
  };
  await pool.query(`
    INSERT INTO release_versions(
      id,version_tag,channel,commit_sha,artifact_sha256,migration_version,release_notes,reason,
      created_by_user_id,idempotency_key,request_id
    ) VALUES($1,'v8.9.0','stable',repeat('8',40),$2,'0083_restricted_cicd_target_authority',
      'Historical rollback target release fixture','Create historical rollback target','release-maker',
      'release-old-target-idempotency','release-old-target-request')
  `, [oldReleaseId, digest("old-target-artifact")]);
  await pool.query(`
    INSERT INTO release_workflow_commands(
      id,release_version_id,environment,action,reason,maker_user_id,idempotency_key,
      canonical_payload_sha256,snapshot_sha256,snapshot_json,artifact_manifest_sha256,
      workflow_sha256,environment_generation,expected_current_release_version_id
    ) VALUES($1,$2,'staging','deploy','Historical target deployment command','release-maker',$3,$4,$5,$6::jsonb,
      repeat('c',64),repeat('d',64),1,NULL)
  `, [
    oldCommandId, oldReleaseId, "old-target-command-idempotency",
    digest("old-target-command-payload"), digest("old-target-command-snapshot"),
    JSON.stringify({
      releaseTag: "v8.9.0", releaseCommitSha: "8".repeat(40), imageDigests: oldImageDigests,
      artifactManifestSha256: sha("c"), migrationSetSha256: sha("9"),
      migrationVersion: "0083_restricted_cicd_target_authority", hasIrreversibleMigrations: false,
    }),
  ]);
  await pool.query(`
    INSERT INTO release_workflow_run_policy_attestations(
      id,repository_id,workflow_id,run_id,run_attempt,job_id,environment,
      environment_policy_sha256,runner_policy_sha256,review_evidence_sha256,oidc_jti_sha256,
      nonce,key_id,signature,expires_at
    ) VALUES($1,'7001','8001','9401',1,'9501','staging',repeat('3',64),repeat('4',64),
      $2,$3,'old-target-attestation-nonce','auditor-key-1','fixture-signature',CURRENT_TIMESTAMP + interval '10 minutes')
  `, ["attestation-old-target-history", digest("old-target-review"), digest("old-target-oidc")]);
  await pool.query(`
    INSERT INTO release_workflow_authorizations(
      id,command_id,attempt_key,attestation_id,run_id,run_attempt,oidc_jti_sha256,
      authorization_nonce,operation_id,expires_at
    ) VALUES($1,$2,'attempt-old-target',$3,'9401',1,$4,'old-target-authorization-nonce',$5,
      CURRENT_TIMESTAMP + interval '10 minutes')
  `, [
    "authorization-old-target-history", oldCommandId, "attestation-old-target-history",
    digest("old-target-oidc"), oldOperationId,
  ]);
  await pool.query(`
    INSERT INTO release_workflow_target_operations(
      id,authorization_id,command_id,environment,action,snapshot_sha256,artifact_manifest_sha256,
      workflow_sha256,environment_generation,expected_current_release_version_id,worker_fencing_token,owner_epoch
    ) VALUES($1,$2,$3,'staging','deploy',$4,repeat('c',64),repeat('d',64),1,NULL,1,1)
  `, [
    oldOperationId, "authorization-old-target-history", oldCommandId,
    digest("old-target-command-snapshot"),
  ]);
  await pool.query(`
    INSERT INTO release_workflow_receipts(
      id,operation_id,command_id,receipt_nonce,key_id,payload_json,payload_sha256,signature,
      phase,owner_epoch,journal_sequence,actual_previous_release_version_id,
      actual_current_release_version_id,signature_verified,received_at
    ) VALUES($1,$2,$3,'old-target-health-nonce','target-key-1',$4::jsonb,$5,'fixture-signature',
      'health_verified',1,5,NULL,$6,true,CURRENT_TIMESTAMP - interval '1 hour')
  `, [
    "receipt-old-target-health", oldOperationId, oldCommandId,
    JSON.stringify({
      releaseVersionId: oldReleaseId, artifactManifestSha256: sha("c"),
      imageDigests: oldImageDigests, migrationRegistrySha256: sha("9"),
    }),
    oldReceiptSha256, oldReleaseId,
  ]);

  const rollbackEvidenceExpiresAt = new Date(Date.now() + 8 * 60_000).toISOString();
  const rollbackRecoveryCapability = {
    capabilityId: "restore-capability-staging-1",
    rehearsalBackupId: "rehearsal-backup-staging-1",
    rehearsalBackupSha256: sha("a"),
    restoreTocSha256: sha("b"),
    restorePlanSha256: sha("c"),
    restoreDrillVersion: "restore-drill-v1",
    restoreDrillResult: "passed",
    verifiedAt: new Date(Date.now() - 60_000).toISOString(),
    retentionDeadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    minimumMigrationVersion: "0083_restricted_cicd_target_authority",
    maximumMigrationVersion: "0084_restricted_cicd_maintenance_control",
    targetManifestSha256: sha("c"),
    targetManifestCompatible: true,
    compatibilityEvidenceSha256: sha("d"),
  };
  const rollbackDigest = (await pool.query(`
    SELECT encode(sha256(convert_to(jsonb_build_object(
      'schemaVersion','1','environment','staging','targetReleaseVersionId',$1::text,
      'currentReleaseVersionId','release-next','targetHealthReceiptSha256',$2::text,
      'currentHealthReceiptSha256',repeat('c',64),'migrationSetSha256',repeat('9',64),
      'recoveryCapability',$4::jsonb,
      'rollbackEvidenceExpiresAt',$3::text
    )::text,'UTF8')),'hex') AS digest
  `, [oldReleaseId, oldReceiptSha256, rollbackEvidenceExpiresAt, JSON.stringify(rollbackRecoveryCapability)])).rows[0].digest;
  const rollbackCommandId = "command-staging-rollback-prerequisite";
  const rollbackSnapshot = {
    schemaVersion: "1", commandId: rollbackCommandId, releaseVersionId: oldReleaseId,
    environment: "staging", action: "rollback", migrationSetSha256: sha("9"),
    migrationVersion: "0083_restricted_cicd_target_authority",
    releaseTag: "v8.9.0", releaseCommitSha: "8".repeat(40), imageDigests: oldImageDigests,
    artifactManifestSha256: sha("c"),
    hasIrreversibleMigrations: false, rollbackEvidenceSha256: rollbackDigest,
    rollbackEvidenceExpiresAt, rollbackRecoveryCapability,
    targetHealthReceiptSha256: oldReceiptSha256, currentHealthReceiptSha256: sha("c"),
    expiresAt: fixtureSnapshotExpiresAt,
  };
  async function insertRollbackFixture(input) {
    const snapshotSha256 = digest(`${input.commandId}-snapshot`);
    await pool.query(`
      INSERT INTO release_workflow_commands(
        id,release_version_id,environment,action,reason,maker_user_id,idempotency_key,
        canonical_payload_sha256,snapshot_sha256,snapshot_json,artifact_manifest_sha256,
        workflow_sha256,environment_generation,expected_current_release_version_id
      ) VALUES($1,$2,'staging','rollback',$3,'release-maker',$4,$5,$6,$7::jsonb,
        repeat('c',64),repeat('d',64),1,'release-next')
    `, [
      input.commandId, oldReleaseId, input.reason, `${input.commandId}-idempotency`,
      digest(`${input.commandId}-payload`), snapshotSha256, JSON.stringify(input.snapshot),
    ]);
    await pool.query(`
      INSERT INTO release_workflow_attempts(
        id,attempt_key,command_id,activation_id,environment,fact_kind,lease_owner,fencing_token,
        environment_generation,snapshot_sha256,lease_expires_at,provider_run_id,provider_run_attempt
      ) VALUES($1,$2,$3,'activation-staging-1','staging','run_bound','fixture-worker',1,1,$4,
        CURRENT_TIMESTAMP + interval '10 minutes',$5,1)
    `, [
      `${input.commandId}-run`, `${input.commandId}-attempt`, input.commandId, snapshotSha256, input.runId,
    ]);
  }
  await insertRollbackFixture({
    commandId: rollbackCommandId, reason: "Rollback prerequisite recomputation fixture",
    snapshot: rollbackSnapshot, runId: "9402",
  });
  await pool.query(
    "SELECT release_workflow_assert_target_prerequisites($1,$2,$3)",
    [rollbackCommandId, sha("5"), sha("6")],
  );

  const missingRecoveryCommandId = "command-staging-rollback-no-recovery";
  await insertRollbackFixture({
    commandId: missingRecoveryCommandId, reason: "Missing restore rehearsal capability fixture", runId: "9406",
    snapshot: { ...rollbackSnapshot, commandId: missingRecoveryCommandId,
      rollbackRecoveryCapability: null },
  });
  await assert.rejects(pool.query(
    "SELECT release_workflow_assert_target_prerequisites($1,$2,$3)",
    [missingRecoveryCommandId, sha("5"), sha("6")],
  ), /recovery capability/i);

  const forgedRollbackCommandId = "command-staging-rollback-forged";
  await insertRollbackFixture({
    commandId: forgedRollbackCommandId, reason: "Forged rollback digest fixture", runId: "9403",
    snapshot: { ...rollbackSnapshot, commandId: forgedRollbackCommandId,
      rollbackEvidenceSha256: digest("forged-rollback-evidence") },
  });
  await assert.rejects(pool.query(
    "SELECT release_workflow_assert_target_prerequisites($1,$2,$3)",
    [forgedRollbackCommandId, sha("5"), sha("6")],
  ), /rollback evidence digest mismatch/i);

  const incompatibleRollbackCommandId = "command-staging-rollback-incompatible";
  await insertRollbackFixture({
    commandId: incompatibleRollbackCommandId, reason: "Incompatible migration rollback fixture", runId: "9404",
    snapshot: { ...rollbackSnapshot, commandId: incompatibleRollbackCommandId,
      migrationSetSha256: sha("8") },
  });
  await assert.rejects(pool.query(
    "SELECT release_workflow_assert_target_prerequisites($1,$2,$3)",
    [incompatibleRollbackCommandId, sha("5"), sha("6")],
  ), /rollback history or migration compatibility invalid/i);

  await pool.query(`
    INSERT INTO release_versions(
      id,version_tag,channel,commit_sha,artifact_sha256,migration_version,release_notes,reason,
      created_by_user_id,idempotency_key,request_id
    ) VALUES('release-intermediate-irreversible','v8.9.5','stable',repeat('7',40),$1,
      '0083_restricted_cicd_target_authority','Intermediate irreversible release fixture',
      'Create irreversible history fixture','release-maker','release-intermediate-idempotency',
      'release-intermediate-request')
  `, [digest("intermediate-artifact")]);
  await pool.query(`
    INSERT INTO release_workflow_commands(
      id,release_version_id,environment,action,reason,maker_user_id,idempotency_key,
      canonical_payload_sha256,snapshot_sha256,snapshot_json,artifact_manifest_sha256,
      workflow_sha256,environment_generation,expected_current_release_version_id
    ) VALUES('command-intermediate-irreversible','release-intermediate-irreversible','staging','deploy',
      'Intermediate irreversible deployment fixture','release-maker','command-intermediate-idempotency',
      $1,$2,$3::jsonb,repeat('c',64),repeat('d',64),1,$4)
  `, [
    digest("intermediate-command-payload"), digest("intermediate-command-snapshot"),
    JSON.stringify({ migrationSetSha256: sha("9"), hasIrreversibleMigrations: true }), oldReleaseId,
  ]);
  await pool.query(`
    INSERT INTO release_workflow_run_policy_attestations(
      id,repository_id,workflow_id,run_id,run_attempt,job_id,environment,
      environment_policy_sha256,runner_policy_sha256,review_evidence_sha256,oidc_jti_sha256,
      nonce,key_id,signature,expires_at
    ) VALUES('attestation-intermediate-irreversible','7001','8001','9405',1,'9505','staging',
      repeat('3',64),repeat('4',64),$1,$2,'intermediate-attestation-nonce','auditor-key-1',
      'fixture-signature',CURRENT_TIMESTAMP + interval '10 minutes')
  `, [digest("intermediate-review"), digest("intermediate-oidc")]);
  await pool.query(`
    INSERT INTO release_workflow_authorizations(
      id,command_id,attempt_key,attestation_id,run_id,run_attempt,oidc_jti_sha256,
      authorization_nonce,operation_id,expires_at
    ) VALUES('authorization-intermediate-irreversible','command-intermediate-irreversible',
      'attempt-intermediate-irreversible','attestation-intermediate-irreversible','9405',1,$1,
      'intermediate-authorization-nonce','operation-intermediate-irreversible',
      CURRENT_TIMESTAMP + interval '10 minutes')
  `, [digest("intermediate-oidc")]);
  await pool.query(`
    INSERT INTO release_workflow_target_operations(
      id,authorization_id,command_id,environment,action,snapshot_sha256,artifact_manifest_sha256,
      workflow_sha256,environment_generation,expected_current_release_version_id,worker_fencing_token,owner_epoch
    ) VALUES('operation-intermediate-irreversible','authorization-intermediate-irreversible',
      'command-intermediate-irreversible','staging','deploy',$1,repeat('c',64),repeat('d',64),1,$2,1,1)
  `, [digest("intermediate-command-snapshot"), oldReleaseId]);
  await pool.query(`
    INSERT INTO release_workflow_receipts(
      id,operation_id,command_id,receipt_nonce,key_id,payload_json,payload_sha256,signature,
      phase,owner_epoch,journal_sequence,actual_previous_release_version_id,
      actual_current_release_version_id,signature_verified,received_at
    ) VALUES('receipt-intermediate-irreversible','operation-intermediate-irreversible',
      'command-intermediate-irreversible','intermediate-health-nonce','target-key-1','{}'::jsonb,$1,
      'fixture-signature','health_verified',1,5,$2,'release-intermediate-irreversible',true,
      CURRENT_TIMESTAMP - interval '30 minutes')
  `, [digest("intermediate-health-receipt"), oldReleaseId]);
  await assert.rejects(pool.query(
    "SELECT release_workflow_assert_target_prerequisites($1,$2,$3)",
    [rollbackCommandId, sha("5"), sha("6")],
  ), /rollback history or migration compatibility invalid/i);
});

test("target-owned stop commits one generation and a trust-bound signed receipt", async () => {
  const stop = () => pool.query(`
    SELECT * FROM release_workflow_target_request_stop(
      'stop-staging-target-1','staging','user','release-maker','Target serializes stop after cutover'
    )
  `);
  const [first, replay] = await Promise.all([stop(), stop()]);
  assert.deepEqual([first.rows[0].replayed, replay.rows[0].replayed].sort(), [false, true]);
  assert.ok([first, replay].every((result) => result.rows[0].generation === "2"));
  assert.ok([first, replay].every((result) =>
    result.rows[0].expected_current_release_version_id === "release-next"));
  const payload = {
    kind: "target_stop_receipt", schemaVersion: "1", stopId: "stop-staging-target-1",
    environment: "staging", generation: 2, phase: "stop_committed", activationId: null,
    expectedCurrentReleaseVersionId: "release-next", requestedAt: first.rows[0].requested_at.toISOString(),
    receiptNonce: "stop-staging-target-1-committed", keyId: "target-key-1", actorKind: "target",
    actorFingerprintSha256: sha("a"),
  };
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_append_stop_receipt_v2(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16
    )
  `, [
    "stop-staging-target-receipt-wrong-trust", "stop-staging-target-1", "staging", 2,
    "stop_committed", null, "release-next", payload.receiptNonce, payload.keyId, JSON.stringify(payload), sha("b"),
    "target-stop-signature", "target", sha("a"), sha("f"), true,
  ]), /stop receipt authority mismatch/i);
  const receipt = await pool.query(`
    SELECT * FROM release_workflow_append_stop_receipt_v2(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16
    )
  `, [
    "stop-staging-target-receipt", "stop-staging-target-1", "staging", 2,
    "stop_committed", null, "release-next", payload.receiptNonce, payload.keyId, JSON.stringify(payload), sha("b"),
    "target-stop-signature", "target", sha("a"), sha("6"), true,
  ]);
  assert.deepEqual(receipt.rows[0], {
    stop_receipt_id: "stop-staging-target-receipt", replayed: false,
  });
  assert.deepEqual((await pool.query(`
    SELECT generation,stop_requested FROM release_workflow_environment_states WHERE environment='staging'
  `)).rows[0], { generation: "2", stop_requested: true });
});

test("sticky stop bumps generation and requires a different checker plus a fresh activation to clear", async () => {
  const [first, replay] = await Promise.all([
    pool.query(`SELECT * FROM release_workflow_request_stop('stop-production-1','production','release-maker','Emergency production stop requested')`),
    pool.query(`SELECT * FROM release_workflow_request_stop('stop-production-1','production','release-maker','Emergency production stop requested')`),
  ]);
  assert.deepEqual([first.rows[0].replayed, replay.rows[0].replayed].sort(), [false, true]);
  assert.ok([first, replay].every((result) => result.rows[0].generation === "2"));
  assert.deepEqual((await pool.query(`SELECT generation,stop_requested FROM release_workflow_environment_states WHERE environment='production'`)).rows[0], { generation: "2", stop_requested: true });

  await assert.rejects(requestCommand({
    id: "command-production-stopped",
    environment: "production",
    idempotencyKey: "release-command-production-stopped",
    canonicalPayloadSha256: sha("1"),
    snapshotSha256: sha("2"),
    environmentGeneration: 2,
  }), /environment snapshot stale/i);

  await pool.query(`
    SELECT * FROM release_workflow_record_activation(
      'activation-production-after-stop','production',repeat('1',64),repeat('2',64),repeat('c',64),
      repeat('d',64),repeat('3',64),repeat('4',64),repeat('5',64),repeat('6',64),repeat('7',64),
      repeat('8',64),'security-approver','release-approver','Fresh activation after production stop',
      CURRENT_TIMESTAMP + interval '30 minutes'
    )
  `);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_clear_stop(
      'stop-production-clear-missing-target','production','release-maker','release-checker',
      'activation-production-after-stop','Target confirmation is required before clearing stop'
    )
  `), /target stop confirmation required/i);
  await pool.query(`
    SELECT * FROM release_workflow_append_stop_receipt_v2(
      'stop-receipt-production-committed','stop-production-1','production',2,'stop_committed',NULL,
      NULL,'stop-receipt-nonce-0001','target-stop-key-1',
      '{"schemaVersion":"1","stopId":"stop-production-1","environment":"production","generation":2,"phase":"stop_committed","activationId":null,"expectedCurrentReleaseVersionId":null}'::jsonb,
      repeat('3',64),'target-stop-signature-committed','target',repeat('4',64),repeat('6',64),true
    )
  `);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_clear_stop(
      'stop-production-clear-missing-ack','production','release-maker','release-checker',
      'activation-production-after-stop','Target clear acknowledgement is still required'
    )
  `), /target clear acknowledgement required/i);
  assert.equal((await pool.query(`
    SELECT * FROM release_workflow_prepare_target_clear_ack_v2(
      'stop-production-1','production',2,'activation-production-after-stop',NULL,repeat('6',64)
    )
  `)).rowCount, 1);
  await pool.query(`
    SELECT * FROM release_workflow_append_stop_receipt_v2(
      'stop-receipt-production-clear','stop-production-1','production',2,'clear_acknowledged',
      'activation-production-after-stop',NULL,'stop-receipt-nonce-0002','target-stop-key-1',
      '{"schemaVersion":"1","stopId":"stop-production-1","environment":"production","generation":2,"phase":"clear_acknowledged","activationId":"activation-production-after-stop","expectedCurrentReleaseVersionId":null}'::jsonb,
      repeat('5',64),'target-stop-signature-clear','target',repeat('4',64),repeat('6',64),true
    )
  `);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_clear_stop(
      'stop-production-clear-self','production','release-checker','release-checker',
      'activation-production-after-stop','Self approval cannot clear sticky stop'
    )
  `), /dual control required/i);
  const cleared = await pool.query(`
    SELECT * FROM release_workflow_clear_stop(
      'stop-production-clear-1','production','release-maker','release-checker',
      'activation-production-after-stop','Independent checker cleared sticky production stop'
    )
  `);
  assert.deepEqual(cleared.rows[0], { generation: "3", replayed: false });
  assert.deepEqual((await pool.query(`
    SELECT cleared_generation,expected_current_release_version_id
      FROM release_workflow_validate_target_stop_cleared_v2(
        'stop-production-1','production',2,'activation-production-after-stop',repeat('6',64)
      )
  `)).rows[0], { cleared_generation: "3", expected_current_release_version_id: null });
  assert.deepEqual((await pool.query(`SELECT generation,stop_requested FROM release_workflow_environment_states WHERE environment='production'`)).rows[0], { generation: "3", stop_requested: false });
});

test("late old-run evidence cannot clear a newer lease and reservation survives provider/lease expiry ordering", async () => {
  await pool.query(`
    SELECT * FROM release_workflow_record_first_production_enablement(
      'production-enablement-after-stop','activation-production-after-stop','production-enabler',
      repeat('9',64),repeat('1',64),repeat('2',64),repeat('d',64),repeat('5',64),repeat('6',64),
      'User enabled production after the first cleared stop',CURRENT_TIMESTAMP + interval '20 minutes'
    )
  `);
  await requestCommand({
    id: "command-production-old",
    environment: "production",
    idempotencyKey: "release-command-production-old",
    canonicalPayloadSha256: sha("3"),
    snapshotSha256: sha("4"),
    environmentGeneration: 3,
  });
  await pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-production-old','command-production-old','release-checker','approve',
      'Independent checker approved old production snapshot',repeat('4',64),
      CURRENT_TIMESTAMP + interval '15 minutes'
    )
  `);
  const oldLease = await pool.query(`
    SELECT * FROM release_workflow_lease_command(
      'attempt-production-old','command-production-old','release-worker-old',300,
      'activation-production-after-stop',repeat('1',64),repeat('2',64),repeat('3',64),
      repeat('4',64),repeat('5',64),repeat('6',64),repeat('7',64),repeat('8',64)
    )
  `);
  const oldFencingToken = Number(oldLease.rows[0].fencing_token);
  await pool.query(`
    SELECT * FROM release_workflow_begin_dispatch(
      'attempt-production-old','release-worker-old',$1,repeat('8',64)
    )
  `, [oldFencingToken]);
  await pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-production-old','release-worker-old',$1,'9201',
      'https://github.com/agentnovas/platform/actions/runs/9201',repeat('8',64)
    )
  `, [oldFencingToken]);

  await pool.query(`
    SELECT * FROM release_workflow_request_stop(
      'stop-production-2','production','release-maker','Second stop fences the old production run'
    )
  `);
  await pool.query(`
    SELECT * FROM release_workflow_append_stop_receipt(
      'stop-receipt-production-2-committed','stop-production-2','production',4,'stop_committed',NULL,
      NULL,'stop-receipt-nonce-0003','target-stop-key-1',
      '{"schemaVersion":"1","stopId":"stop-production-2","environment":"production","generation":4,"phase":"stop_committed","activationId":null,"expectedCurrentReleaseVersionId":null}'::jsonb,
      repeat('6',64),'target-stop-signature-2-committed','target',repeat('4',64),true
    )
  `);
  await pool.query(`
    SELECT * FROM release_workflow_record_activation(
      'activation-production-after-stop-2','production',repeat('1',64),repeat('2',64),repeat('c',64),
      repeat('d',64),repeat('3',64),repeat('4',64),repeat('5',64),repeat('6',64),repeat('7',64),
      repeat('8',64),'security-approver','release-approver','Fresh activation after second production stop',
      CURRENT_TIMESTAMP + interval '30 minutes'
    )
  `);
  await pool.query(`
    SELECT * FROM release_workflow_append_stop_receipt(
      'stop-receipt-production-2-clear','stop-production-2','production',4,'clear_acknowledged',
      'activation-production-after-stop-2',NULL,'stop-receipt-nonce-0004','target-stop-key-1',
      '{"schemaVersion":"1","stopId":"stop-production-2","environment":"production","generation":4,"phase":"clear_acknowledged","activationId":"activation-production-after-stop-2","expectedCurrentReleaseVersionId":null}'::jsonb,
      repeat('7',64),'target-stop-signature-2-clear','target',repeat('4',64),true
    )
  `);
  await pool.query(`
    SELECT * FROM release_workflow_clear_stop(
      'stop-production-clear-2','production','release-maker','release-checker',
      'activation-production-after-stop-2','Independent checker cleared the second sticky stop'
    )
  `);
  await pool.query(`
    SELECT * FROM release_workflow_record_first_production_enablement(
      'production-enablement-after-stop-2','activation-production-after-stop-2','production-enabler',
      repeat('9',64),repeat('1',64),repeat('2',64),repeat('d',64),repeat('5',64),repeat('6',64),
      'User enabled production after the second cleared stop',CURRENT_TIMESTAMP + interval '20 minutes'
    )
  `);

  await requestCommand({
    id: "command-production-new",
    environment: "production",
    idempotencyKey: "release-command-production-new",
    canonicalPayloadSha256: sha("5"),
    snapshotSha256: sha("6"),
    environmentGeneration: 5,
  });
  await pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-production-new','command-production-new','release-checker','approve',
      'Independent checker approved new production snapshot',repeat('6',64),
      CURRENT_TIMESTAMP + interval '15 minutes'
    )
  `);
  const newLease = await pool.query(`
    SELECT * FROM release_workflow_lease_command(
      'attempt-production-new','command-production-new','release-worker-new',300,
      'activation-production-after-stop-2',repeat('1',64),repeat('2',64),repeat('3',64),
      repeat('4',64),repeat('5',64),repeat('6',64),repeat('7',64),repeat('8',64)
    )
  `);
  const newFencingToken = Number(newLease.rows[0].fencing_token);
  await pool.query(`
    SELECT * FROM release_workflow_begin_dispatch(
      'attempt-production-new','release-worker-new',$1,repeat('9',64)
    )
  `, [newFencingToken]);
  await pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-production-new','release-worker-new',$1,'9202',
      'https://github.com/agentnovas/platform/actions/runs/9202',repeat('9',64)
    )
  `, [newFencingToken]);
  await pool.query(`
    SELECT * FROM release_workflow_append_provider_event(
      'provider-event-production-old-late','attempt-production-old','release-worker-old',$1,'9201',
      'completed_failure',repeat('1',64),
      '{"runId":"9201","runAttempt":1,"conclusion":"failure"}'::jsonb,CURRENT_TIMESTAMP
    )
  `, [oldFencingToken]);
  assert.deepEqual((await pool.query(`
    SELECT active_attempt_key,generation FROM release_workflow_environment_states WHERE environment='production'
  `)).rows[0], { active_attempt_key: "attempt-production-new", generation: "5" });

  const attestationExpiry = new Date(Date.now() + 10 * 60_000);
  await pool.query(`
    SELECT * FROM release_workflow_append_run_policy_attestation(
      'attestation-production-new','7001','8001','9202',1,'9302','production',repeat('3',64),
      repeat('4',64),repeat('a',64),repeat('e',64),'auditor-nonce-0002','auditor-key-1',
      'ed25519-signature-production-new',$1
    )
  `, [attestationExpiry]);
  const reservationExpiry = new Date(Date.now() + 4 * 60_000);
  await pool.query(`
    SELECT * FROM release_workflow_reserve_exact_run_operation(
      'authorization-production-new','operation-production-new','command-production-new',
      'attempt-production-new','attestation-production-new',repeat('e',64),
      'authorization-nonce-production-new',repeat('2',64),repeat('3',64),$1
    )
  `, [reservationExpiry]);

  await requestCommand({
    id: "command-production-blocked-by-operation",
    environment: "production",
    idempotencyKey: "release-command-production-blocked-op",
    canonicalPayloadSha256: sha("7"),
    snapshotSha256: sha("8"),
    environmentGeneration: 5,
  });
  await pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-production-blocked-op','command-production-blocked-by-operation','release-checker','approve',
      'Independent checker approved operation-blocked snapshot',repeat('8',64),
      CURRENT_TIMESTAMP + interval '15 minutes'
    )
  `);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_lease_command(
      'attempt-production-blocked-op','command-production-blocked-by-operation','release-worker-blocked',300,
      'activation-production-after-stop-2',repeat('1',64),repeat('2',64),repeat('3',64),
      repeat('4',64),repeat('5',64),repeat('6',64),repeat('7',64),repeat('8',64)
    )
  `), /environment snapshot stale/i);

  await pool.query(`
    SELECT * FROM release_workflow_append_provider_event(
      'provider-event-production-new-success','attempt-production-new','release-worker-new',$1,'9202',
      'completed_success',repeat('4',64),
      '{"runId":"9202","runAttempt":1,"conclusion":"success"}'::jsonb,CURRENT_TIMESTAMP
    )
  `, [newFencingToken]);

  const healthPayload = {
    schemaVersion: "1",
    operationId: "operation-production-new",
    commandId: "command-production-new",
    phase: "health_verified",
    ownerEpoch: 1,
    journalSequence: 2,
    actualPreviousReleaseVersionId: null,
    actualCurrentReleaseVersionId: "release-next",
  };
  const earlyHealthPayload = { ...healthPayload, journalSequence: 1 };
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      'receipt-production-health-early','operation-production-new','receipt-nonce-health-early','target-key-1',
      $1::jsonb,repeat('4',64),'target-signature-health-early','health_verified',1,1,NULL,
      'release-next',true
    )
  `, [JSON.stringify(earlyHealthPayload)]), /target receipt phase transition invalid/i);

  const cutoverPayload = {
    ...healthPayload,
    phase: "cutover_committed",
    journalSequence: 1,
  };
  await pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      'receipt-production-cutover','operation-production-new','receipt-nonce-production-cutover','target-key-1',
      $1::jsonb,repeat('5',64),'target-signature-production-cutover','cutover_committed',1,1,NULL,
      'release-next',true
    )
  `, [JSON.stringify(cutoverPayload)]);
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-production-new'`)).rows[0].status, "settling");

  const uncertainClient = await pool.connect();
  try {
    await uncertainClient.query("BEGIN");
    await uncertainClient.query("SAVEPOINT after_cutover_terminal_case");
    const uncertainAfterPayload = {
      ...healthPayload,
      phase: "uncertain_after_cutover",
    };
    await uncertainClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-production-uncertain-after','operation-production-new','receipt-nonce-uncertain-after',
        'target-key-1',$1::jsonb,repeat('6',64),'target-signature-uncertain-after',
        'uncertain_after_cutover',1,2,NULL,'release-next',true
      )
    `, [JSON.stringify(uncertainAfterPayload)]);
    assert.deepEqual((await uncertainClient.query(`
      SELECT command.status,environment.blocked
        FROM release_workflow_command_states AS command
        JOIN release_workflow_environment_states AS environment ON environment.environment='production'
       WHERE command.command_id='command-production-new'
    `)).rows[0], { status: "deployed_reconciliation_required", blocked: true });
    await uncertainClient.query("SAVEPOINT expected_rejection");
    await assert.rejects(uncertainClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-production-after-uncertain','operation-production-new','receipt-nonce-after-uncertain',
        'target-key-1',
        '{"schemaVersion":"1","operationId":"operation-production-new","commandId":"command-production-new","phase":"health_verified","ownerEpoch":1,"journalSequence":3,"actualPreviousReleaseVersionId":null,"actualCurrentReleaseVersionId":"release-next"}'::jsonb,
        repeat('7',64),'target-signature-after-uncertain','health_verified',1,3,NULL,
        'release-next',true
      )
    `), /terminal target receipt phase/i);
    await uncertainClient.query("ROLLBACK TO SAVEPOINT expected_rejection");
    await assert.rejects(uncertainClient.query(`
      SELECT * FROM release_workflow_takeover_target_operation(
        'target-owner-after-uncertain-after','operation-production-new',1,2,repeat('a',64),repeat('b',64),
        'A terminal post-cutover uncertainty must refuse deployment ownership'
      )
    `), /target operation terminal/i);
    await uncertainClient.query("ROLLBACK TO SAVEPOINT expected_rejection");

    await uncertainClient.query("ROLLBACK TO SAVEPOINT after_cutover_terminal_case");
    const healthFailedPayload = {
      ...healthPayload,
      phase: "health_failed_after_cutover",
    };
    await uncertainClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-production-health-failed','operation-production-new','receipt-nonce-health-failed',
        'target-key-1',$1::jsonb,repeat('ac',32),'target-signature-health-failed',
        'health_failed_after_cutover',1,2,NULL,'release-next',true
      )
    `, [JSON.stringify(healthFailedPayload)]);
    await uncertainClient.query("SAVEPOINT expected_rejection");
    await assert.rejects(uncertainClient.query(`
      SELECT * FROM release_workflow_takeover_target_operation(
        'target-owner-after-health-failed','operation-production-new',1,2,repeat('a',64),repeat('b',64),
        'A terminal health failure must refuse deployment ownership'
      )
    `), /target operation terminal/i);
  } finally {
    await uncertainClient.query("ROLLBACK");
    uncertainClient.release();
  }

  await pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      'receipt-production-health','operation-production-new','receipt-nonce-production-health','target-key-1',
      $1::jsonb,repeat('8',64),'target-signature-production-health','health_verified',1,2,NULL,
      'release-next',true
    )
  `, [JSON.stringify(healthPayload)]);
  await assert.rejects(pool.query(`
    SELECT * FROM release_workflow_takeover_target_operation(
      'target-owner-after-health-verified','operation-production-new',1,2,repeat('a',64),repeat('b',64),
      'A terminal health success must refuse deployment ownership'
    )
  `), /target operation terminal/i);
  assert.deepEqual((await pool.query(`
    SELECT command.status,environment.blocked,environment.active_operation_id
      FROM release_workflow_command_states AS command
      JOIN release_workflow_environment_states AS environment ON environment.environment='production'
     WHERE command.command_id='command-production-new'
  `)).rows[0], { status: "succeeded", blocked: false, active_operation_id: null });

  await requestCommand({
    id: "command-production-after-success",
    environment: "production",
    idempotencyKey: "release-command-production-after-success",
    canonicalPayloadSha256: sha("9"),
    snapshotSha256: sha("a"),
    environmentGeneration: 5,
    expectedCurrentReleaseVersionId: "release-next",
  });
  await pool.query(`
    SELECT * FROM release_workflow_review_command(
      'approval-production-after-success','command-production-after-success','release-checker','approve',
      'Independent checker approved the post-success command',repeat('a',64),
      CURRENT_TIMESTAMP + interval '15 minutes'
    )
  `);
  const afterSuccessLease = await pool.query(`
    SELECT * FROM release_workflow_lease_command(
      'attempt-production-after-success','command-production-after-success','release-worker-after-success',300,
      'activation-production-after-stop-2',repeat('1',64),repeat('2',64),repeat('3',64),
      repeat('4',64),repeat('5',64),repeat('6',64),repeat('7',64),repeat('8',64)
    )
  `);
  const afterSuccessFencingToken = Number(afterSuccessLease.rows[0].fencing_token);
  await pool.query(`
    SELECT * FROM release_workflow_begin_dispatch(
      'attempt-production-after-success','release-worker-after-success',$1,repeat('b',64)
    )
  `, [afterSuccessFencingToken]);
  await pool.query(`
    SELECT * FROM release_workflow_bind_provider_run(
      'attempt-production-after-success','release-worker-after-success',$1,'9203',
      'https://github.com/agentnovas/platform/actions/runs/9203',repeat('b',64)
    )
  `, [afterSuccessFencingToken]);
  const afterSuccessAttestationExpiry = new Date(Date.now() + 10 * 60_000);
  await pool.query(`
    SELECT * FROM release_workflow_append_run_policy_attestation(
      'attestation-production-after-success','7001','8001','9203',1,'9303','production',repeat('3',64),
      repeat('4',64),repeat('b',64),repeat('f',64),'auditor-nonce-0003','auditor-key-1',
      'ed25519-signature-production-after-success',$1
    )
  `, [afterSuccessAttestationExpiry]);
  const afterSuccessReservationExpiry = new Date(Date.now() + 4 * 60_000);
  await pool.query(`
    SELECT * FROM release_workflow_reserve_exact_run_operation(
      'authorization-production-after-success','operation-production-after-success',
      'command-production-after-success','attempt-production-after-success',
      'attestation-production-after-success',repeat('f',64),'authorization-nonce-after-success',
      repeat('c',64),repeat('d',64),$1
    )
  `, [afterSuccessReservationExpiry]);

  const afterSuccessCutoverPayload = {
    schemaVersion: "1",
    operationId: "operation-production-after-success",
    commandId: "command-production-after-success",
    phase: "cutover_committed",
    ownerEpoch: 1,
    journalSequence: 1,
    actualPreviousReleaseVersionId: "release-next",
    actualCurrentReleaseVersionId: "release-next",
  };
  const afterSuccessHealthPayload = {
    ...afterSuccessCutoverPayload,
    phase: "health_verified",
    journalSequence: 2,
  };
  const reverseOrderClient = await pool.connect();
  try {
    await reverseOrderClient.query("BEGIN");
    await reverseOrderClient.query(`
      SELECT * FROM release_workflow_append_provider_event(
        'provider-event-production-after-success-ok','attempt-production-after-success',
        'release-worker-after-success',$1,'9203','completed_success',repeat('d',64),
        '{"runId":"9203","runAttempt":1,"conclusion":"success"}'::jsonb,CURRENT_TIMESTAMP
      )
    `, [afterSuccessFencingToken]);
    await reverseOrderClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-production-after-success-cutover','operation-production-after-success',
        'receipt-nonce-after-success-cutover','target-key-1',$1::jsonb,repeat('e',64),
        'target-signature-after-success-cutover','cutover_committed',1,1,
        'release-next','release-next',true
      )
    `, [JSON.stringify(afterSuccessCutoverPayload)]);
    await reverseOrderClient.query(`
      SELECT * FROM release_workflow_append_target_receipt(
        'receipt-production-after-success-health','operation-production-after-success',
        'receipt-nonce-after-success-health','target-key-1',$1::jsonb,repeat('f',64),
        'target-signature-after-success-health','health_verified',1,2,
        'release-next','release-next',true
      )
    `, [JSON.stringify(afterSuccessHealthPayload)]);
    await reverseOrderClient.query(`
      SELECT * FROM release_workflow_append_provider_event(
        'provider-event-production-new-failed','attempt-production-new','release-worker-new',$1,'9202',
        'completed_failure',repeat('9',64),
        '{"runId":"9202","runAttempt":1,"conclusion":"failure"}'::jsonb,CURRENT_TIMESTAMP
      )
    `, [newFencingToken]);
    assert.equal((await reverseOrderClient.query(`
      SELECT blocked FROM release_workflow_environment_states WHERE environment='production'
    `)).rows[0].blocked, true);
  } finally {
    await reverseOrderClient.query("ROLLBACK");
    reverseOrderClient.release();
  }

  await pool.query(`
    SELECT * FROM release_workflow_append_provider_event(
      'provider-event-production-new-failed','attempt-production-new','release-worker-new',$1,'9202',
      'completed_failure',repeat('9',64),
      '{"runId":"9202","runAttempt":1,"conclusion":"failure"}'::jsonb,CURRENT_TIMESTAMP
    )
  `, [newFencingToken]);
  assert.equal((await pool.query(`SELECT status FROM release_workflow_command_states WHERE command_id='command-production-new'`)).rows[0].status, "deployed_reconciliation_required");
  assert.deepEqual((await pool.query(`
    SELECT expected_current_release_version_id,blocked,active_operation_id,active_attempt_key
      FROM release_workflow_environment_states WHERE environment='production'
  `)).rows[0], {
    expected_current_release_version_id: "release-next",
    blocked: true,
    active_operation_id: "operation-production-after-success",
    active_attempt_key: "attempt-production-after-success",
  });

  await pool.query(`
    SELECT * FROM release_workflow_append_provider_event(
      'provider-event-production-after-success-ok','attempt-production-after-success',
      'release-worker-after-success',$1,'9203','completed_success',repeat('d',64),
      '{"runId":"9203","runAttempt":1,"conclusion":"success"}'::jsonb,CURRENT_TIMESTAMP
    )
  `, [afterSuccessFencingToken]);
  await pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      'receipt-production-after-success-cutover','operation-production-after-success',
      'receipt-nonce-after-success-cutover','target-key-1',$1::jsonb,repeat('e',64),
      'target-signature-after-success-cutover','cutover_committed',1,1,
      'release-next','release-next',true
    )
  `, [JSON.stringify(afterSuccessCutoverPayload)]);
  await pool.query(`
    SELECT * FROM release_workflow_append_target_receipt(
      'receipt-production-after-success-health','operation-production-after-success',
      'receipt-nonce-after-success-health','target-key-1',$1::jsonb,repeat('f',64),
      'target-signature-after-success-health','health_verified',1,2,
      'release-next','release-next',true
    )
  `, [JSON.stringify(afterSuccessHealthPayload)]);
  assert.deepEqual((await pool.query(`
    SELECT blocked,active_operation_id,active_attempt_key
      FROM release_workflow_environment_states WHERE environment='production'
  `)).rows[0], { blocked: true, active_operation_id: null, active_attempt_key: null });
});
