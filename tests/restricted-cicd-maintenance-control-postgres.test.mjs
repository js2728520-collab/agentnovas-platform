import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";
import {
  parseRestrictedCicdHumanActionEnvelope,
  restrictedCicdHumanActionMutationDocument,
  restrictedCicdHumanActionMutationSha256,
} from "../lib/restricted-cicd-human-action.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `restricted_cicd_maint_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
let controlPool;
let identityPool;
let maintPool;
const fixtureRolePassword = `t82d2-${process.pid}-${Date.now()}`;
const fixtureRoleNames = Object.freeze([
  "agentnovas_release_control",
  "agentnovas_release_identity_verifier",
  "agentnovas_maint_web",
]);
const createdFixtureRoles = [];
const sha = (letter) => letter.repeat(64);
const sessionSecrets = Object.freeze({
  maker: "maintenance-maker-session-secret-0001",
  security: "maintenance-security-session-secret-0002",
  release: "maintenance-release-session-secret-0003",
  revoked: "maintenance-revoked-session-secret-0004",
  stale: "maintenance-stale-session-secret-0005",
  service: "maintenance-service-session-secret-0006",
  forged: "maintenance-forged-session-secret-9999",
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  for (const roleName of fixtureRoleNames) {
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [roleName]);
    if (existing.rowCount === 0) {
      assert.match(roleName, /^[a-z0-9_]+$/);
      await admin.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${fixtureRolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      createdFixtureRoles.push(roleName);
    }
  }
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const migrated = await runPostgresMigrations(pool, { directory: new URL("../postgres/migrations/", import.meta.url), commitSha: "t8-2c-maintenance-control" });
  assert.ok(migrated.applied.includes("0084_restricted_cicd_maintenance_control.sql"));
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('maker','maker@quality.invalid','test','hq_admin','active'),
      ('release-creator','creator@quality.invalid','test','hq_admin','active'),
      ('security-checker','security@quality.invalid','test','hq_admin','active'),
      ('release-checker','release@quality.invalid','test','hq_admin','active'),
      ('revoked-checker','revoked@quality.invalid','test','hq_admin','active'),
      ('stale-mfa-checker','stale@quality.invalid','test','hq_admin','active'),
      ('service-checker','service@quality.invalid','test','hq_admin','active');
    INSERT INTO sessions(id,user_id,token_hash,app_audience,expires_at,mfa_level,mfa_verified_at,last_seen_at,idle_expires_at,absolute_expires_at)
    VALUES
      ('session-maker','maker',encode(sha256(convert_to('maintenance-maker-session-secret-0001','UTF8')),'hex'),'maintenance',(now()+interval '2 hours')::text,'totp',now(),now(),now()+interval '1 hour',now()+interval '2 hours'),
      ('session-security','security-checker',encode(sha256(convert_to('maintenance-security-session-secret-0002','UTF8')),'hex'),'maintenance',(now()+interval '2 hours')::text,'totp',now(),now(),now()+interval '1 hour',now()+interval '2 hours'),
      ('session-release','release-checker',encode(sha256(convert_to('maintenance-release-session-secret-0003','UTF8')),'hex'),'maintenance',(now()+interval '2 hours')::text,'totp',now(),now(),now()+interval '1 hour',now()+interval '2 hours'),
      ('session-revoked','revoked-checker',encode(sha256(convert_to('maintenance-revoked-session-secret-0004','UTF8')),'hex'),'maintenance',(now()+interval '2 hours')::text,'totp',now(),now(),now()+interval '1 hour',now()+interval '2 hours'),
      ('session-stale','stale-mfa-checker',encode(sha256(convert_to('maintenance-stale-session-secret-0005','UTF8')),'hex'),'maintenance',(now()+interval '2 hours')::text,'totp',now()-interval '1 hour',now(),now()+interval '1 hour',now()+interval '2 hours'),
      ('session-service','service-checker',encode(sha256(convert_to('maintenance-service-session-secret-0006','UTF8')),'hex'),'maintenance',(now()+interval '2 hours')::text,'totp',now(),now(),now()+interval '1 hour',now()+interval '2 hours');
    INSERT INTO roles(id,application_id,code,name,kind,status,is_system)
    VALUES('fixture-release-control-role','maintenance','fixture-release-control','Fixture release control','custom','published',false);
    INSERT INTO role_permissions(id,role_id,permission_key,scope,scope_organization_ids_json)
    SELECT 'fixture-release-control-permission-'||md5(permission.key),'fixture-release-control-role',permission.key,'PLATFORM','[]'::jsonb
      FROM permission_definitions permission WHERE permission.key LIKE 'maint.releases.workflow.%';
    INSERT INTO user_role_assignments(id,user_id,role_id,application_id,status,effective_at,reason)
    SELECT 'fixture-assignment-'||fixture.user_id,fixture.user_id,'fixture-release-control-role','maintenance','active',now()-interval '1 minute','Restricted CI/CD fixture assignment'
      FROM (VALUES('maker'),('security-checker'),('release-checker'),('revoked-checker'),('stale-mfa-checker'),('service-checker')) fixture(user_id);
    INSERT INTO release_workflow_actor_authorities(user_id,actor_kind,identity_evidence_sha256)
    VALUES
      ('maker','human',repeat('1',64)),
      ('security-checker','human',repeat('2',64)),
      ('release-checker','human',repeat('3',64)),
      ('revoked-checker','human',repeat('4',64)),
      ('stale-mfa-checker','human',repeat('5',64)),
      ('service-checker','service',repeat('6',64));
    INSERT INTO release_versions(id,version_tag,channel,commit_sha,artifact_sha256,migration_version,release_notes,reason,created_by_user_id,idempotency_key,request_id)
    VALUES('release-t82c','v9.2.0-beta.1','beta',repeat('a',40),repeat('c',64),'0084_restricted_cicd_maintenance_control','Restricted CI/CD Maintenance control fixture release','Create fixture release','release-creator','fixture-release-idem','fixture-release-request');
    INSERT INTO release_verifications(id,release_version_id,decision,evidence_sha256,reviewer_user_id,reason,idempotency_key,request_id)
    VALUES('release-t82c-verification','release-t82c','approve',repeat('f',64),'release-checker','Verify fixture release independently','fixture-verification-idem','fixture-verification-request');
  `);
  const provider = { provider: "github_actions", apiVersion: "2026-03-10", apiBaseUrl: "https://api.github.com", repositoryOwner: "agentnovas", repositoryName: "platform", repositoryId: "7001", appId: "7002", installationId: "7003", accountId: "7004", workflowId: "8001", workflowPath: ".github/workflows/restricted-deployment.yml", workflowControlRef: "refs/tags/release-control-v1", controlCommitSha: "a".repeat(40), workflowSha256: sha("d"), environment: "staging", oidcAudience: "https://deploy.agentnovas.internal", runnerEnvironment: "github-hosted" };
  await pool.query("SELECT * FROM release_workflow_record_provider_binding($1,$2::jsonb)", [sha("b"), JSON.stringify(provider)]);
  await pool.query(`
    INSERT INTO release_workflow_artifact_manifests(
      release_version_id,artifact_manifest_sha256,client_image_sha256,operations_image_sha256,
      maintenance_image_sha256,runtime_image_sha256,migration_set_sha256,migration_version,
      has_irreversible_migrations,provenance_evidence_sha256,material_sha256
    ) VALUES('release-t82c',$1,$2,$3,$4,$5,$6,'0084_restricted_cicd_maintenance_control',false,$7,$8)
  `, [sha("c"),sha("5"),sha("6"),sha("7"),sha("8"),sha("9"),sha("f"),sha("0")]);
  await pool.query(`
    INSERT INTO release_workflow_control_bundles(
      id,environment,artifact_manifest_sha256,g7_manifest_sha256,provider_binding_sha256,workflow_sha256,
      environment_policy_sha256,runner_policy_sha256,target_binding_sha256,receipt_trust_sha256,
      auditor_trust_sha256,reviewer_allowlist_sha256,provenance_evidence_sha256,expires_at
    ) VALUES
      ('bundle-staging','staging',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '3 hours'),
      ('bundle-production','production',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '3 hours')
  `, [sha("c"),sha("1"),sha("b"),sha("d"),sha("e"),sha("f"),sha("1"),sha("2"),sha("3"),sha("4"),sha("a")]);
  await pool.query(`
    GRANT USAGE ON SCHEMA "${schema}" TO agentnovas_release_control,agentnovas_release_identity_verifier,agentnovas_maint_web;
    DO $grant$
    DECLARE gateway record;
    BEGIN
      FOR gateway IN SELECT procedure.oid::regprocedure AS identity FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
        WHERE namespace.nspname=current_schema()
          AND procedure.proname='release_workflow_execute_human_action'
      LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',gateway.identity);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agentnovas_release_control',gateway.identity);
      END LOOP;
      FOR gateway IN SELECT procedure.oid::regprocedure AS identity FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
        WHERE namespace.nspname=current_schema() AND procedure.proname='release_workflow_issue_human_action_authority'
      LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',gateway.identity);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agentnovas_maint_web',gateway.identity);
      END LOOP;
      FOR gateway IN SELECT procedure.oid::regprocedure AS identity FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
        WHERE namespace.nspname=current_schema() AND procedure.proname IN (
          'release_workflow_record_human_action_assertion','release_workflow_resolve_human_action_assertion'
        )
      LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',gateway.identity);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agentnovas_release_identity_verifier',gateway.identity);
      END LOOP;
    END
    $grant$;
  `);
  const controlUrl = new URL(databaseUrl);
  controlUrl.username = "agentnovas_release_control";
  controlUrl.password = createdFixtureRoles.includes("agentnovas_release_control") ? fixtureRolePassword : "";
  controlUrl.searchParams.set("options", `-csearch_path=${schema}`);
  controlPool = new pg.Pool({ connectionString: controlUrl.toString(), max: 1 });
  const identityUrl = new URL(databaseUrl);
  identityUrl.username = "agentnovas_release_identity_verifier";
  identityUrl.password = createdFixtureRoles.includes("agentnovas_release_identity_verifier") ? fixtureRolePassword : "";
  identityUrl.searchParams.set("options", `-csearch_path=${schema}`);
  identityPool = new pg.Pool({ connectionString: identityUrl.toString(), max: 1 });
  const maintUrl = new URL(databaseUrl);
  maintUrl.username = "agentnovas_maint_web";
  maintUrl.password = createdFixtureRoles.includes("agentnovas_maint_web") ? fixtureRolePassword : "";
  maintUrl.searchParams.set("options", `-csearch_path=${schema}`);
  maintPool = new pg.Pool({ connectionString: maintUrl.toString(), max: 1 });
});

test.after(async () => {
  await controlPool?.end();
  await identityPool?.end();
  await maintPool?.end();
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  for (const roleName of createdFixtureRoles.reverse()) {
    await admin.query(`DROP OWNED BY "${roleName}"`);
    await admin.query(`DROP ROLE "${roleName}"`);
  }
  await admin.end();
});

test("activation requires two real reviewers and command approval freezes server-owned authority fields", async () => {
  const expires = new Date(Date.now() + 60 * 60_000);
  await pool.query(`SELECT * FROM release_workflow_request_activation_v2(
    'activation-request','release-t82c','staging',$1,$2,$3,$4,$5
  )`, [sessionSecrets.maker,"Request staging activation safely","activation-request-idem","activation-request-http",expires]);
  await assert.rejects(pool.query(`SELECT * FROM release_workflow_review_activation_v2('activation-self','activation-request',$1,'security','approve','Self approval must be rejected','self-http')`, [sessionSecrets.maker]), /self approval/i);
  const first = await pool.query(`SELECT * FROM release_workflow_review_activation_v2('activation-security','activation-request',$1,'security','approve','Approve security activation binding','security-http')`, [sessionSecrets.security]);
  assert.equal(first.rows[0].completed, false);
  const second = await pool.query(`SELECT * FROM release_workflow_review_activation_v2('activation-release','activation-request',$1,'release','approve','Approve release activation binding','release-http')`, [sessionSecrets.release]);
  assert.equal(second.rows[0].completed, true);
  assert.equal((await pool.query("SELECT count(*)::int count FROM release_workflow_activations WHERE id='activation-request'")).rows[0].count, 1);

  await pool.query(`SELECT * FROM release_workflow_request_command_v2('command-request','release-t82c','staging','deploy',$1,$2,$3,$4)`, [sessionSecrets.maker,"Request staging deployment safely","command-request-idem","command-request-http"]);
  await assert.rejects(pool.query(`SELECT * FROM release_workflow_review_command_v2('command-self','command-request','staging',$1,'approve','Self approval must be rejected','command-self-http',$2)`, [sessionSecrets.maker,expires]), /self approval/i);
  await pool.query(`SELECT * FROM release_workflow_review_command_v2('command-review','command-request','staging',$1,'approve','Approve frozen staging snapshot','command-review-http',$2)`, [sessionSecrets.release,expires]);
  const command = await pool.query("SELECT snapshot_json,environment_generation,maker_user_id FROM release_workflow_commands WHERE id='command-request'");
  assert.equal(command.rows[0].maker_user_id, "maker");
  assert.equal(command.rows[0].snapshot_json.checkerUserId, "release-checker");
  assert.equal(command.rows[0].snapshot_json.environmentGeneration, Number(command.rows[0].environment_generation));
  assert.equal(command.rows[0].snapshot_json.controlCommitSha, "a".repeat(40));
  assert.equal(command.rows[0].snapshot_json.imageDigests.client, sha("5"));
  assert.equal(command.rows[0].snapshot_json.migrationSetSha256, sha("9"));
  assert.equal(command.rows[0].snapshot_json.hasIrreversibleMigrations, false);
  assert.equal(command.rows[0].snapshot_json.snapshotSha256.length, 64);
  assert.equal((await pool.query(`
    SELECT count(*)::int count FROM audit_logs
     WHERE action LIKE 'release.workflow.%' AND subject_id IN ('activation-request','command-request')
  `)).rows[0].count, 5);
});

test("database actor assertion rejects revoked permission and stale MFA", async () => {
  await pool.query("UPDATE user_role_assignments SET status='revoked',revoked_at=now() WHERE user_id='revoked-checker'");
  await assert.rejects(
    pool.query("SELECT * FROM release_workflow_require_maintenance_actor($1,'maint.releases.workflow.activation.approve')", [sessionSecrets.revoked]),
    /permission or recent MFA unavailable/i,
  );
  await assert.rejects(
    pool.query("SELECT * FROM release_workflow_require_maintenance_actor($1,'maint.releases.workflow.activation.approve')", [sessionSecrets.stale]),
    /permission or recent MFA unavailable/i,
  );
  await assert.rejects(
    pool.query("SELECT * FROM release_workflow_require_maintenance_actor($1,'maint.releases.workflow.activation.approve')", [sessionSecrets.service]),
    /permission or recent MFA unavailable/i,
  );
});

test("actor assertion locks the live assignment until the control transaction commits", async () => {
  const control = await pool.connect();
  let transactionOpen = false;
  let revocation;
  try {
    await control.query("BEGIN");
    transactionOpen = true;
    await control.query("SELECT * FROM release_workflow_require_maintenance_actor($1,'maint.releases.workflow.activation.approve')", [sessionSecrets.security]);
    let revoked = false;
    revocation = pool.query("UPDATE user_role_assignments SET status='revoked',revoked_at=now() WHERE user_id='security-checker'")
      .then(() => { revoked = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(revoked, false);
    await control.query("COMMIT");
    transactionOpen = false;
    await revocation;
    assert.equal(revoked, true);
  } finally {
    if (transactionOpen) await control.query("ROLLBACK").catch(() => undefined);
    control.release();
    await revocation?.catch(() => undefined);
    await pool.query("UPDATE user_role_assignments SET status='active',revoked_at=NULL WHERE user_id='security-checker'");
  }
});

test("dedicated release-control role cannot read identity tables, record assertions, or call bare mutations", async () => {
  await assert.rejects(controlPool.query("SELECT token_hash FROM sessions LIMIT 1"), /permission denied/i);
  const directMutationPrivileges = await controlPool.query(`
    SELECT procedure.proname,has_function_privilege(current_user,procedure.oid,'EXECUTE') allowed
      FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
     WHERE namespace.nspname=current_schema() AND procedure.proname=ANY($1::text[])
     ORDER BY procedure.proname
  `, [[
    "release_workflow_request_activation_v2","release_workflow_review_activation_v2",
    "release_workflow_enable_first_production_v2","release_workflow_request_command_v2",
    "release_workflow_review_command_v2","release_workflow_request_stop_v2",
    "release_workflow_request_stop_release_v2","release_workflow_review_stop_release_v2",
  ]]);
  assert.equal(directMutationPrivileges.rows.length, 8);
  assert.ok(directMutationPrivileges.rows.every((row) => row.allowed === false));
  await assert.rejects(controlPool.query(`SELECT release_workflow_append_maintenance_audit(
    'forged-audit',$1,'release.workflow.stop.requested','release_workflow_environment','staging','forged-http','{}'::jsonb
  )`, [sessionSecrets.maker]), /permission denied/i);
  const storedHash = (await pool.query("SELECT token_hash FROM sessions WHERE id='session-maker'")).rows[0].token_hash;
  await assert.rejects(
    controlPool.query(`SELECT * FROM release_workflow_request_activation_v2(
      'hash-replay-activation','release-t82c','staging',$1,'Stored session hash must not be a bearer','hash-replay-idem','hash-replay-http',$2
    )`, [storedHash,new Date(Date.now()+30*60_000)]),
    /permission denied/i,
  );
  await assert.rejects(
    controlPool.query(`SELECT * FROM release_workflow_request_activation_v2(
      'forged-activation','release-t82c','staging',$1,'Forged actor request must fail','forged-activation-idem','forged-activation-http',$2
    )`, [sessionSecrets.forged,new Date(Date.now()+30*60_000)]),
    /permission denied/i,
  );
  await assert.rejects(controlPool.query(`SELECT * FROM release_workflow_request_activation_v2(
    'control-role-activation','release-t82c','staging',$1,'Bare control mutation must be rejected','control-role-activation-idem','control-role-activation-http',$2
  )`, [sessionSecrets.maker,new Date(Date.now()+30*60_000)]), /permission denied/i);
  await assert.rejects(controlPool.query(`SELECT * FROM release_workflow_record_human_action_assertion(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
  )`, ["forged-assertion","release-authority-"+"f".repeat(48),"maker","maint.releases.workflow.activation.request",
    "activation.request",sha("1"),sha("2"),sha("3"),sha("4"),7,"forged-assertion-idem","forged-http",
    new Date(),new Date(Date.now()+60_000),sha("5"),"credential-id-quality","client-data-quality","authenticator-data-quality","signature-quality"]), /permission denied/i);
  await assert.rejects(identityPool.query("SELECT release_workflow_execute_human_action($1,$2,$3,$4)", [
    "forged-assertion",sessionSecrets.maker,"{}",sha("1"),
  ]), /permission denied/i);
  await assert.rejects(identityPool.query("SELECT token_hash FROM sessions LIMIT 1"), /permission denied/i);
  await assert.rejects(identityPool.query(`SELECT * FROM release_workflow_issue_human_action_authority(
    $1,$2,$3,$4,$5,$6,$7
  )`, ["maker",sessionSecrets.maker,"maint.releases.workflow.activation.request","activation.request",sha("1"),"forged-issuer-idem","forged-issuer-http"]), /permission denied/i);
  await assert.rejects(maintPool.query("SELECT release_workflow_execute_human_action($1,$2,$3,$4)", [
    "forged-assertion",sessionSecrets.maker,"{}",sha("1"),
  ]), /permission denied/i);
});

test("independent verifier records signed bytes and release control atomically consumes the exact action", async () => {
  const verifiedAt = new Date();
  const expiresAt = new Date(verifiedAt.getTime() + 90_000);
  const envelope = parseRestrictedCicdHumanActionEnvelope({
    schemaVersion: "1", operation: "activation.request", actorUserId: "maker",
    sessionSecret: sessionSecrets.maker, idempotencyKey: "human-assertion-idempotency",
    requestId: "human-assertion-http", parameters: {}, body: {
      releaseVersionId: "release-t82c", environment: "staging",
      reason: "Request exact signed activation safely", expiresAt: new Date(Date.now()+30*60_000).toISOString(),
    },
  });
  const mutationDocument = restrictedCicdHumanActionMutationDocument(envelope);
  const mutationSha256 = restrictedCicdHumanActionMutationSha256(envelope);
  const authority = await maintPool.query(`SELECT * FROM release_workflow_issue_human_action_authority(
    $1,$2,$3,$4,$5,$6,$7
  )`, ["maker",sessionSecrets.maker,"maint.releases.workflow.activation.request","activation.request",
    mutationSha256,"human-assertion-idempotency","human-assertion-http"]);
  assert.equal(authority.rows[0].replayed, false);
  const authorityReplay = await maintPool.query(`SELECT * FROM release_workflow_issue_human_action_authority(
    $1,$2,$3,$4,$5,$6,$7
  )`, ["maker",sessionSecrets.maker,"maint.releases.workflow.activation.request","activation.request",
    mutationSha256,"human-assertion-idempotency","human-assertion-http"]);
  assert.equal(authorityReplay.rows[0].authority_id, authority.rows[0].authority_id);
  const values = [
    "release-assertion-quality-db-1",authority.rows[0].authority_id,"maker","maint.releases.workflow.activation.request",
    "activation.request",mutationSha256,sha("2"),sha("3"),sha("4"),7,
    "human-assertion-idempotency","human-assertion-http",verifiedAt,expiresAt,sha("5"),
    "credential-id-quality","client-data-quality","authenticator-data-quality","signature-quality",
  ];
  const first = await identityPool.query(`SELECT * FROM release_workflow_record_human_action_assertion(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
  )`, values);
  assert.equal(first.rows[0].replayed, false);
  const identityResponseLossRecovery = await identityPool.query(`SELECT * FROM release_workflow_resolve_human_action_assertion(
    $1,$2,$3,$4,$5,$6
  )`, [authority.rows[0].authority_id,"maker","activation.request",mutationSha256,
    "human-assertion-idempotency","human-assertion-http"]);
  assert.deepEqual(identityResponseLossRecovery.rows[0], { assertion_id: values[0], consumed: false });
  const replay = await identityPool.query(`SELECT * FROM release_workflow_record_human_action_assertion(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
  )`, values);
  assert.equal(replay.rows[0].replayed, true);
  const stored = (await pool.query(`SELECT actor_user_id,permission_key,operation,mutation_sha256,sign_count
    FROM release_workflow_human_action_assertions WHERE challenge_id=$1`, [values[0]])).rows[0];
  assert.deepEqual(stored, {
    actor_user_id: "maker", permission_key: "maint.releases.workflow.activation.request",
    operation: "activation.request", mutation_sha256: mutationSha256, sign_count: "7",
  });
  await assert.rejects(identityPool.query(`SELECT * FROM release_workflow_record_human_action_assertion(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
  )`, [...values.slice(0, 5),sha("9"),...values.slice(6)]), /assertion invalid|replay mismatch/i);
  const executed = await controlPool.query("SELECT release_workflow_execute_human_action($1,$2,$3,$4) result", [
    values[0],sessionSecrets.maker,mutationDocument,mutationSha256,
  ]);
  assert.equal(executed.rows[0].result.activation_request_id.startsWith("activation-request-"), true);
  assert.equal(executed.rows[0].result.replayed, false);
  const controlResponseLossRecovery = await identityPool.query(`SELECT * FROM release_workflow_resolve_human_action_assertion(
    $1,$2,$3,$4,$5,$6
  )`, [authority.rows[0].authority_id,"maker","activation.request",mutationSha256,
    "human-assertion-idempotency","human-assertion-http"]);
  assert.deepEqual(controlResponseLossRecovery.rows[0], { assertion_id: values[0], consumed: true });
  const consumedReplay = await controlPool.query("SELECT release_workflow_execute_human_action($1,$2,$3,$4) result", [
    values[0],sessionSecrets.maker,mutationDocument,mutationSha256,
  ]);
  assert.deepEqual(consumedReplay.rows[0].result, executed.rows[0].result);
  assert.equal((await pool.query("SELECT count(*)::int count FROM release_workflow_activation_requests WHERE id=$1", [
    executed.rows[0].result.activation_request_id,
  ])).rows[0].count, 1);
  const changedEnvelope = parseRestrictedCicdHumanActionEnvelope({ ...envelope, body: { ...envelope.body, reason: "A different signed payload must fail" } });
  await assert.rejects(controlPool.query("SELECT release_workflow_execute_human_action($1,$2,$3,$4)", [
    values[0],sessionSecrets.maker,restrictedCicdHumanActionMutationDocument(changedEnvelope),
    restrictedCicdHumanActionMutationSha256(changedEnvelope),
  ]), /exact human action assertion unavailable/i);

  const crossSessionEnvelope = parseRestrictedCicdHumanActionEnvelope({ ...envelope,
    sessionSecret: sessionSecrets.security, idempotencyKey: "cross-session-assertion-idempotency",
    requestId: "cross-session-assertion-http",
  });
  const crossSessionDocument = restrictedCicdHumanActionMutationDocument(crossSessionEnvelope);
  const crossSessionSha256 = restrictedCicdHumanActionMutationSha256(crossSessionEnvelope);
  const crossAuthority = await maintPool.query(`SELECT * FROM release_workflow_issue_human_action_authority(
    $1,$2,$3,$4,$5,$6,$7
  )`, ["maker",sessionSecrets.maker,"maint.releases.workflow.activation.request","activation.request",
    crossSessionSha256,"cross-session-assertion-idempotency","cross-session-assertion-http"]);
  await identityPool.query(`SELECT * FROM release_workflow_record_human_action_assertion(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
  )`, ["release-assertion-cross-session-1",crossAuthority.rows[0].authority_id,"maker",
    "maint.releases.workflow.activation.request","activation.request",crossSessionSha256,sha("6"),sha("7"),sha("8"),8,
    "cross-session-assertion-idempotency","cross-session-assertion-http",new Date(),new Date(Date.now()+90_000),sha("9"),
    "credential-cross-session","client-data-cross-session","authenticator-cross-session","signature-cross-session"]);
  await assert.rejects(controlPool.query("SELECT release_workflow_execute_human_action($1,$2,$3,$4)", [
    "release-assertion-cross-session-1",sessionSecrets.security,crossSessionDocument,crossSessionSha256,
  ]), /session authority mismatch/i);

  const ttlEnvelope = parseRestrictedCicdHumanActionEnvelope({ ...envelope,
    idempotencyKey: "ttl-consumed-assertion-idempotency", requestId: "ttl-consumed-assertion-http",
  });
  const ttlDocument = restrictedCicdHumanActionMutationDocument(ttlEnvelope);
  const ttlSha256 = restrictedCicdHumanActionMutationSha256(ttlEnvelope);
  const ttlOperationId = `activation-request-${createHash("sha256")
    .update("maker\0activation-request\0ttl-consumed-assertion-idempotency").digest("hex").slice(0, 48)}`;
  await pool.query(`
    INSERT INTO release_workflow_human_action_authorities(
      authority_id,actor_user_id,session_secret_sha256,recent_mfa_evidence_sha256,permission_key,operation,
      mutation_sha256,idempotency_key,request_id,expires_at,issued_at
    ) VALUES('release-authority-${"d".repeat(48)}','maker',encode(sha256(convert_to($1,'UTF8')),'hex'),$2,
      'maint.releases.workflow.activation.request','activation.request',$3,'ttl-consumed-assertion-idempotency',
      'ttl-consumed-assertion-http',now()-interval '6 minutes',now()-interval '8 minutes')
  `, [sessionSecrets.maker,sha("a"),ttlSha256]);
  await pool.query(`
    INSERT INTO release_workflow_human_action_assertions(
      challenge_id,authority_id,actor_user_id,permission_key,operation,mutation_sha256,assertion_sha256,
      credential_id_sha256,origin_sha256,policy_sha256,credential_id,client_data_json,authenticator_data,signature,
      sign_count,idempotency_key,request_id,verified_at,expires_at,registered_at
    ) VALUES('release-assertion-ttl-consumed','release-authority-${"d".repeat(48)}','maker',
      'maint.releases.workflow.activation.request','activation.request',$1,$2,$3,$4,$5,
      'credential-ttl-consumed','client-data-ttl-consumed','authenticator-ttl-consumed','signature-ttl-consumed',9,
      'ttl-consumed-assertion-idempotency','ttl-consumed-assertion-http',now()-interval '7 minutes',
      now()-interval '6 minutes',now()-interval '7 minutes')
  `, [ttlSha256,sha("b"),sha("c"),sha("d"),sha("e")]);
  await pool.query(`
    INSERT INTO release_workflow_human_action_assertion_consumptions(
      assertion_id,actor_user_id,operation,mutation_sha256,idempotency_key,request_id,operation_id,result_json,consumed_at
    ) VALUES('release-assertion-ttl-consumed','maker','activation.request',$1,
      'ttl-consumed-assertion-idempotency','ttl-consumed-assertion-http',$2,
      '{"activation_request_id":"ttl-historical-result","replayed":false}'::jsonb,now()-interval '5 minutes')
  `, [ttlSha256,ttlOperationId]);
  const ttlResolved = await identityPool.query(`SELECT * FROM release_workflow_resolve_human_action_assertion(
    $1,$2,$3,$4,$5,$6
  )`, ["release-authority-"+"d".repeat(48),"maker","activation.request",ttlSha256,
    "ttl-consumed-assertion-idempotency","ttl-consumed-assertion-http"]);
  assert.deepEqual(ttlResolved.rows[0], { assertion_id: "release-assertion-ttl-consumed", consumed: true });
  const ttlReplay = await controlPool.query("SELECT release_workflow_execute_human_action($1,$2,$3,$4) result", [
    "release-assertion-ttl-consumed",sessionSecrets.maker,ttlDocument,ttlSha256,
  ]);
  assert.deepEqual(ttlReplay.rows[0].result, { activation_request_id: "ttl-historical-result", replayed: false });
});

test("concurrent activation approvals serialize and still finalize exactly once", async () => {
  const expires = new Date(Date.now() + 60 * 60_000);
  await pool.query(`SELECT * FROM release_workflow_request_activation_v2(
    'activation-request-concurrent','release-t82c','production',$1,$2,$3,$4,$5
  )`, [sessionSecrets.maker,"Request concurrent activation review safely","activation-concurrent-idem","activation-concurrent-http",expires]);

  const [security, release] = await Promise.all([
    pool.query(`SELECT * FROM release_workflow_review_activation_v2(
      'activation-concurrent-security','activation-request-concurrent',$1,'security','approve',
      'Approve concurrent security binding','activation-concurrent-security-http'
    )`, [sessionSecrets.security]),
    pool.query(`SELECT * FROM release_workflow_review_activation_v2(
      'activation-concurrent-release','activation-request-concurrent',$1,'release','approve',
      'Approve concurrent release binding','activation-concurrent-release-http'
    )`, [sessionSecrets.release]),
  ]);

  assert.equal([security.rows[0].completed, release.rows[0].completed].filter(Boolean).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int count FROM release_workflow_activations WHERE id='activation-request-concurrent'")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int count FROM release_workflow_activation_request_reviews WHERE activation_request_id='activation-request-concurrent'")).rows[0].count, 2);
});

test("safe Maintenance projection omits secret and raw provider material", async () => {
  const result = await pool.query("SELECT release_workflow_read_maintenance_control(50) payload");
  const payload = result.rows[0].payload;
  assert.ok(payload.activationRequests.some((request) => request.id === "activation-request"));
  assert.ok(payload.activationRequests.some((request) => request.id === "activation-request-concurrent"));
  assert.ok(payload.commandRequests.some((request) => request.id === "command-request"));
  const commandRequest = payload.commandRequests.find((request) => request.id === "command-request");
  assert.equal(commandRequest.material.materialSha256, sha("0"));
  assert.equal(commandRequest.material.provenanceEvidenceSha256, sha("f"));
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["signature", "authorizationNonce", "oidcJti", "material_json", "apiBaseUrl"])
    assert.equal(serialized.includes(forbidden), false, forbidden);
});
