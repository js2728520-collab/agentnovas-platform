import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertControlledRehearsalDatabaseName,
  assertLoopbackPostgresUrl,
  assertRecoveryRehearsalDatabaseRoles,
  assertRestorableMigrationEvidence,
  assertRecoveryRehearsalAuthorized,
  databaseConnectionOptions,
} from "../scripts/release/postgres-recovery-rehearsal.mjs";
import {
  EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES,
  EXPECTED_RELEASE_DATABASE_ROLES,
  evaluatePostgresRolePolicy,
} from "../scripts/release/postgres-role-policy.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("recovery rehearsal accepts only an explicit isolated loopback PostgreSQL source", () => {
  const parsed = assertLoopbackPostgresUrl("postgresql://rehearsal:secret@127.0.0.1:5433/agentnovas_recovery_source_release1");
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.pathname, "/agentnovas_recovery_source_release1");

  for (const unsafe of [
    "postgresql://db.internal/agentnovas",
    "postgresql://localhost/postgres",
    "postgresql://rehearsal@127.0.0.1/agentnovas_local",
    "postgresql://[::1]/template1",
    "postgresql:///agentnovas",
    "mysql://127.0.0.1/agentnovas",
    "postgresql://127.0.0.1/",
  ]) {
    assert.throws(() => assertLoopbackPostgresUrl(unsafe), /unsafe|explicit|rehearsal/i, unsafe);
  }
});

test("recovery rehearsal uses the dedicated migrator for FORCE RLS evidence", () => {
  const source = new URL("postgresql://agentnovas_migrator:secret@127.0.0.1/agentnovas_recovery_source_release1");
  const admin = new URL("postgresql://agentnovas_migrator:secret@127.0.0.1/postgres");
  assert.doesNotThrow(() => assertRecoveryRehearsalDatabaseRoles({ source, admin }));

  assert.throws(() => assertRecoveryRehearsalDatabaseRoles({
    source: new URL("postgresql://rehearsal_role:secret@127.0.0.1/agentnovas_recovery_source_release1"),
    admin,
  }), /agentnovas_migrator/i);
  assert.throws(() => assertRecoveryRehearsalDatabaseRoles({
    source,
    admin: new URL("postgresql://rehearsal_role:secret@127.0.0.1/postgres"),
  }), /agentnovas_migrator/i);
});

test("recovery rehearsal requires a complete checksummed migration registry", () => {
  assert.throws(() => assertRestorableMigrationEvidence({ tables: [], migrations: [] }), /migration registry/i);
  assert.throws(() => assertRestorableMigrationEvidence({
    tables: ["_agentnovas_migrations"],
    migrations: [{ name: "0000_base.sql", checksum: null, commitSha: null }],
  }), /checksum/i);
  assert.doesNotThrow(() => assertRestorableMigrationEvidence({
    tables: ["_agentnovas_migrations"],
    migrations: [{ name: "0000_base.sql", checksum: "a".repeat(64), commitSha: null }],
  }));
});

test("recovery rehearsal requires two explicit execution gates", () => {
  assert.throws(
    () => assertRecoveryRehearsalAuthorized({ execute: false, environment: { RELEASE_REHEARSAL_ALLOW_LOCAL: "1" } }),
    /--execute/i,
  );
  assert.throws(
    () => assertRecoveryRehearsalAuthorized({ execute: true, environment: {} }),
    /RELEASE_REHEARSAL_ALLOW_LOCAL=1/i,
  );
  assert.doesNotThrow(() => assertRecoveryRehearsalAuthorized({
    execute: true,
    environment: { RELEASE_REHEARSAL_ALLOW_LOCAL: "1" },
  }));
});

test("recovery rehearsal owns one narrowly named temporary database and never embeds credentials in command arguments", () => {
  const name = "agentnovas_restore_rehearsal_123_1720000000000_a1b2c3";
  assert.equal(assertControlledRehearsalDatabaseName(name), name);
  for (const unsafe of ["agentnovas", "postgres", "agentnovas_restore_rehearsal_", "agentnovas_restore_rehearsal_123;drop database postgres"])
    assert.throws(() => assertControlledRehearsalDatabaseName(unsafe), /controlled rehearsal database/i);

  const options = databaseConnectionOptions(new URL("postgresql://release_user:very-secret@127.0.0.1:5433/agentnovas_local"));
  assert.deepEqual(options.args, ["--host", "127.0.0.1", "--port", "5433", "--username", "release_user"]);
  assert.equal(options.environment.PGPASSWORD, "very-secret");
  assert.equal(options.args.join(" ").includes("very-secret"), false);
});

test("database role policy rejects elevated roles, broad PUBLIC grants, and disabled-worker access", () => {
  assert.ok(EXPECTED_RELEASE_DATABASE_ROLES.includes("agentnovas_payment_webhook"));
  const safeRoles = EXPECTED_RELEASE_DATABASE_ROLES.map((roleName) => ({
    roleName,
    canLogin: !EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES.includes(roleName),
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
  }));
  assert.deepEqual(evaluatePostgresRolePolicy({
    roles: safeRoles,
    grants: [],
    schemaGrants: [],
    routineGrants: [],
    memberships: [],
  }), []);

  const findings = evaluatePostgresRolePolicy({
    roles: safeRoles.map((role) => role.roleName === "agentnovas_ops_web" ? { ...role, superuser: true } : role),
    grants: [
      { grantee: "PUBLIC", tableName: "users", privilegeType: "SELECT" },
      { grantee: "agentnovas_notification_worker", tableName: "wallet_balances", privilegeType: "UPDATE" },
      { grantee: "agentnovas_payment_worker", tableName: "ledger_postings", privilegeType: "INSERT" },
      { grantee: "agentnovas_research_worker", tableName: "strategy_research_runs", privilegeType: "SELECT" },
      { grantee: "agentnovas_client_web", tableName: "platform_demo_accounts", privilegeType: "SELECT" },
      { grantee: "agentnovas_ops_web", tableName: "llm_profile_revisions", privilegeType: "SELECT" },
      { grantee: "agentnovas_client_web", tableName: "release_versions", privilegeType: "SELECT" },
      { grantee: "agentnovas_payment_webhook", tableName: "users", privilegeType: "SELECT" },
    ],
    schemaGrants: [{ grantee: "agentnovas_demo_execution_worker", privilegeType: "CREATE" }],
    memberships: [{ memberRole: "agentnovas_client_web", grantedRole: "pg_read_all_data" }],
    routineGrants: [{ grantee: "PUBLIC", routineName: "audit_platform_demo_controls", privilegeType: "EXECUTE" }],
  });
  assert.ok(findings.some((finding) => finding.code === "ELEVATED_ROLE"));
  assert.ok(findings.some((finding) => finding.code === "PUBLIC_TABLE_GRANT"));
  assert.ok(findings.some((finding) => finding.code === "WORKER_TABLE_GRANT"));
  assert.ok(findings.some((finding) => finding.code === "DISABLED_WORKER_ACCESS"));
  assert.ok(findings.some((finding) => finding.code === "SCHEMA_CREATE_GRANT"));
  assert.equal(findings.filter((finding) => finding.code === "WEB_SECRET_GRANT").length, 2);
  assert.ok(findings.some((finding) => finding.code === "ROLE_MEMBERSHIP"));
  assert.ok(findings.some((finding) => finding.code === "PUBLIC_ROUTINE_GRANT"));
  assert.ok(findings.some((finding) => finding.code === "RELEASE_CONTROL_TABLE_GRANT"));
  assert.ok(findings.some((finding) => finding.code === "WORKER_TABLE_GRANT" && finding.roleName === "agentnovas_payment_webhook"));
});

test("restricted CI/CD roles use explicit login states and receive only pinned gateway routines", () => {
  const roles = EXPECTED_RELEASE_DATABASE_ROLES.map((roleName) => ({
    roleName,
    canLogin: !EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES.includes(roleName),
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
  }));
  const grantsByRole = new Map([
    ["agentnovas_maint_web", ["release_workflow_read_maintenance_control", "release_workflow_issue_human_action_authority"]],
    ["agentnovas_release_control", ["release_workflow_execute_human_action"]],
    ["agentnovas_release_identity_verifier", [
      "release_workflow_record_human_action_assertion",
      "release_workflow_resolve_human_action_assertion",
    ]],
    ["agentnovas_release_worker", [
      "release_workflow_recover_expired_dispatch_v2",
      "release_workflow_claim_next_reconciliation_v2",
      "release_workflow_claim_next_command_v2",
      "release_workflow_begin_dispatch",
      "release_workflow_record_dispatch_unknown",
      "release_workflow_bind_provider_run",
      "release_workflow_reject_bound_run",
      "release_workflow_append_provider_event",
      "release_workflow_worker_heartbeat",
    ]],
    ["agentnovas_release_ingress", ["release_workflow_append_delivery"]],
    ["agentnovas_release_auditor", ["release_workflow_append_run_policy_attestation"]],
    ["agentnovas_release_target_gateway", [
      "release_workflow_reserve_workflow_target_request_v4",
      "release_workflow_validate_target_authority_v2",
      "release_workflow_validate_target_cutover_v2",
      "release_workflow_recover_target_operation_v2",
      "release_workflow_list_recoverable_target_operations_v2",
      "release_workflow_assert_migration_registry",
      "release_workflow_takeover_target_operation",
      "release_workflow_append_target_receipt",
      "release_workflow_target_request_stop",
      "release_workflow_prepare_target_clear_ack_v2",
      "release_workflow_validate_target_stop_cleared_v2",
      "release_workflow_append_stop_receipt_v2",
    ]],
  ]);
  const routineGrants = [...grantsByRole].flatMap(([grantee,routines]) => routines.map((routineName) => ({
    grantee,routineName,privilegeType: "EXECUTE",
  })));
  const restrictedCicdRoutines = [...grantsByRole].flatMap(([grantee,routines]) => routines.map((routineName) => ({
    routineName,
    ownerName: "agentnovas_migrator",
    securityDefiner: true,
    config: ["search_path=pg_catalog, public"],
    executeGrantees: ["agentnovas_migrator",grantee],
  })));
  const input = {
    roles,
    grants: [{ grantee: "agentnovas_maint_web", tableName: "release_workflow_safe_status", privilegeType: "SELECT" }],
    schemaGrants: [],
    sequenceGrants: [],
    routineGrants,
    memberships: [],
    restrictedCicdRoutines,
  };
  assert.equal(roles.find((role) => role.roleName === "agentnovas_release_worker")?.canLogin, true);
  assert.equal(EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES.includes("agentnovas_release_worker"), false);
  assert.equal(roles.find((role) => role.roleName === "agentnovas_release_ingress")?.canLogin, true);
  assert.equal(EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES.includes("agentnovas_release_ingress"), false);
  assert.equal(roles.find((role) => role.roleName === "agentnovas_release_auditor")?.canLogin, true);
  assert.equal(EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES.includes("agentnovas_release_auditor"), false);
  assert.deepEqual(evaluatePostgresRolePolicy(input), []);

  const maintenanceAccountGateway = evaluatePostgresRolePolicy({
    ...input,
    routineGrants: [...input.routineGrants, {
      grantee: "agentnovas_maint_web",
      routineName: "user_app_preference_read",
      privilegeType: "EXECUTE",
    }],
  });
  assert.equal(maintenanceAccountGateway.some((finding) => (
    finding.code === "RESTRICTED_CICD_ROUTINE_GRANT"
    && finding.message.includes("user_app_preference_read")
  )), false);

  const elevatedWorker = evaluatePostgresRolePolicy({
    ...input,
    roles: roles.map((role) => role.roleName === "agentnovas_release_worker"
      ? { ...role, superuser: true }
      : role),
  });
  assert.ok(elevatedWorker.some((finding) => finding.code === "ELEVATED_ROLE"
    && finding.roleName === "agentnovas_release_worker"));
  const workerMembership = evaluatePostgresRolePolicy({
    ...input,
    memberships: [{ memberRole: "agentnovas_release_worker", grantedRole: "agentnovas_migrator" }],
  });
  assert.ok(workerMembership.some((finding) => finding.code === "ROLE_MEMBERSHIP"
    && finding.roleName === "agentnovas_release_worker"));
  const inboundWorkerMembership = evaluatePostgresRolePolicy({
    ...input,
    memberships: [{ memberRole: "stale_external_login", grantedRole: "agentnovas_release_worker" }],
  });
  assert.ok(inboundWorkerMembership.some((finding) => finding.code === "ROLE_MEMBERSHIP"
    && finding.roleName === "agentnovas_release_worker"));
  const workerSchemaCreate = evaluatePostgresRolePolicy({
    ...input,
    schemaGrants: [{ grantee: "agentnovas_release_worker", privilegeType: "CREATE" }],
  });
  assert.ok(workerSchemaCreate.some((finding) => finding.code === "SCHEMA_CREATE_GRANT"));
  const workerSequence = evaluatePostgresRolePolicy({
    ...input,
    sequenceGrants: [{
      grantee: "agentnovas_release_worker",
      sequenceName: "release_workflow_events_sequence_no_seq",
      privilegeType: "USAGE",
    }],
  });
  assert.ok(workerSequence.some((finding) => finding.code === "RESTRICTED_CICD_DIRECT_SEQUENCE_GRANT"));

  const directTable = evaluatePostgresRolePolicy({
    ...input,
    grants: [...input.grants, {
      grantee: "agentnovas_release_worker",
      tableName: "release_workflow_commands",
      privilegeType: "SELECT",
    }],
  });
  assert.ok(directTable.some((finding) => finding.code === "RESTRICTED_CICD_DIRECT_TABLE_GRANT"));
  const broadRoutine = evaluatePostgresRolePolicy({
    ...input,
    routineGrants: [...input.routineGrants, {
      grantee: "agentnovas_release_ingress",
      routineName: "release_workflow_reserve_exact_run_operation",
      privilegeType: "EXECUTE",
    }],
  });
  assert.ok(broadRoutine.some((finding) => finding.code === "RESTRICTED_CICD_ROUTINE_GRANT"));
  const unpinned = restrictedCicdRoutines.map((routine) => (
    routine.routineName === "release_workflow_claim_next_command_v2" ? { ...routine, config: [] } : routine
  ));
  assert.ok(evaluatePostgresRolePolicy({ ...input, restrictedCicdRoutines: unpinned })
    .some((finding) => finding.code === "RESTRICTED_CICD_GATEWAY_UNSAFE"));
});

test("configuration activation worker grants are checked at table and privilege level", () => {
  const roles = EXPECTED_RELEASE_DATABASE_ROLES.map((roleName) => ({
    roleName,
    canLogin: !EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES.includes(roleName),
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
  }));
  const base = {
    roles,
    schemaGrants: [],
    sequenceGrants: [],
    routineGrants: [{ grantee: "agentnovas_configuration_activation_worker", routineName: "configuration_activation_worker_activate", privilegeType: "EXECUTE" }],
    memberships: [],
  };
  const safeGrants = [
    ["configuration_versions", "SELECT"],
    ["configuration_test_results", "SELECT"],
    ["configuration_approvals", "SELECT"],
    ["configuration_schedules", "SELECT"],
    ["configuration_activations", "SELECT"],
    ["worker_instances", "SELECT"],
    ["worker_instances", "INSERT"],
    ["worker_instances", "UPDATE"],
  ].map(([tableName, privilegeType]) => ({ grantee: "agentnovas_configuration_activation_worker", tableName, privilegeType }));
  assert.deepEqual(evaluatePostgresRolePolicy({ ...base, grants: safeGrants }), []);
  for (const [tableName, privilegeType] of [["configuration_approvals", "INSERT"], ["configuration_versions", "UPDATE"], ["configuration_activations", "INSERT"], ["configuration_activations", "DELETE"], ["audit_logs", "INSERT"]]) {
    const findings = evaluatePostgresRolePolicy({
      ...base,
      grants: [...safeGrants, { grantee: "agentnovas_configuration_activation_worker", tableName, privilegeType }],
    });
    const expectedCode = tableName === "audit_logs" ? "WORKER_TABLE_GRANT" : "WORKER_TABLE_PRIVILEGE";
    assert.ok(findings.some((finding) => finding.code === expectedCode));
  }
  const sequenceFindings = evaluatePostgresRolePolicy({
    ...base,
    grants: safeGrants,
    sequenceGrants: [...base.sequenceGrants, {
      grantee: "agentnovas_configuration_activation_worker",
      sequenceName: "configuration_activations_sequence_no_seq",
      privilegeType: "USAGE",
    }],
  });
  assert.ok(sequenceFindings.some((finding) => finding.code === "WORKER_SEQUENCE_GRANT"));
  const routineFindings = evaluatePostgresRolePolicy({
    ...base,
    grants: safeGrants,
    routineGrants: [...base.routineGrants, {
      grantee: "agentnovas_configuration_activation_worker",
      routineName: "protect_versioned_configuration_append_only",
      privilegeType: "EXECUTE",
    }],
  });
  assert.ok(routineFindings.some((finding) => finding.code === "WORKER_ROUTINE_GRANT"));
});

test("configuration activation gateway stays owner-controlled with a pinned path", () => {
  const roles = EXPECTED_RELEASE_DATABASE_ROLES.map((roleName) => ({
    roleName,
    canLogin: !EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES.includes(roleName),
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
  }));
  const gateway = {
    signature: "configuration_activation_worker_activate(text)",
    ownerName: "agentnovas_migrator",
    securityDefiner: true,
    config: ["search_path=\"public\",pg_catalog"],
    executeGrantees: ["agentnovas_configuration_activation_worker", "agentnovas_migrator"],
  };
  const input = {
    roles,
    grants: [],
    schemaGrants: [],
    routineGrants: [],
    memberships: [],
    configurationActivationRoutines: [gateway],
  };
  assert.deepEqual(evaluatePostgresRolePolicy(input), []);
  for (const unsafe of [
    { ...gateway, ownerName: "agentnovas_configuration_activation_worker" },
    { ...gateway, securityDefiner: false },
    { ...gateway, config: null },
    { ...gateway, executeGrantees: [...gateway.executeGrantees, "PUBLIC"] },
  ]) {
    const findings = evaluatePostgresRolePolicy({ ...input, configurationActivationRoutines: [unsafe] });
    assert.ok(findings.some((finding) => finding.code === "CONFIGURATION_ACTIVATION_GATEWAY_UNSAFE"));
  }
});

test("Client feature flag gateway stays read-only, owner-controlled and narrowly granted", () => {
  const roles = EXPECTED_RELEASE_DATABASE_ROLES.map((roleName) => ({
    roleName,
    canLogin: !EXPECTED_NOLOGIN_RELEASE_DATABASE_ROLES.includes(roleName),
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
  }));
  const gateway = {
    signature: "configuration_client_active_feature_flag(text)",
    ownerName: "agentnovas_migrator",
    securityDefiner: true,
    config: ["search_path=\"public\",pg_catalog"],
    executeGrantees: ["agentnovas_client_web", "agentnovas_migrator"],
  };
  const input = {
    roles,
    grants: [],
    schemaGrants: [],
    routineGrants: [{ grantee: "agentnovas_client_web", routineName: "configuration_client_active_feature_flag", privilegeType: "EXECUTE" }],
    memberships: [],
    configurationConsumerRoutines: [gateway],
  };
  assert.deepEqual(evaluatePostgresRolePolicy(input), []);
  for (const unsafe of [
    { ...gateway, ownerName: "agentnovas_client_web" },
    { ...gateway, securityDefiner: false },
    { ...gateway, config: null },
    { ...gateway, executeGrantees: [...gateway.executeGrantees, "PUBLIC"] },
  ]) {
    const findings = evaluatePostgresRolePolicy({ ...input, configurationConsumerRoutines: [unsafe] });
    assert.ok(findings.some((finding) => finding.code === "CONFIGURATION_CONSUMER_GATEWAY_UNSAFE"));
  }
  const broadGrant = evaluatePostgresRolePolicy({
    ...input,
    routineGrants: [...input.routineGrants, {
      grantee: "agentnovas_client_web",
      routineName: "configuration_client_arbitrary_reader",
      privilegeType: "EXECUTE",
    }],
  });
  assert.ok(broadGrant.some((finding) => finding.code === "CONFIGURATION_CONSUMER_ROUTINE_GRANT"));
});

test("database role policy verifies Client identity RLS ownership and restrictive policies", () => {
  const identityTables = [
    "users",
    "sessions",
    "auth_tokens",
    "user_mfa_totp_credentials",
    "user_mfa_recovery_codes",
  ].map((tableName) => ({ tableName, rlsEnabled: true, forceRlsEnabled: true, ownerName: "agentnovas_migrator" }));
  const identityPolicies = identityTables.flatMap(({ tableName }) => {
    const allowedRoles = tableName === "users"
      ? "'agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web','agentnovas_notification_worker'"
      : "'agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'";
    const baseName = tableName === "user_mfa_totp_credentials" ? "mfa_totp_identity_base_access"
      : tableName === "user_mfa_recovery_codes" ? "mfa_recovery_identity_base_access"
        : `${tableName}_identity_base_access`;
    return [{
      tableName,policyName: `${tableName}_client_identity_partition`,restrictive: true,command: "*",policyRoles: ["PUBLIC"],
      usingExpression: `current_user IN (${allowedRoles})`,
      checkExpression: `current_user IN (${allowedRoles})`,
    }, {
      tableName,policyName: baseName,restrictive: false,command: "*",policyRoles: ["PUBLIC"],
      usingExpression: "true",checkExpression: "true",
    }];
  });
  assert.deepEqual(evaluatePostgresRolePolicy({
    roles: [], grants: [], schemaGrants: [], identityTables, identityPolicies,
  }).filter((finding) => finding.code.startsWith("IDENTITY_")), []);

  const findings = evaluatePostgresRolePolicy({
    roles: [],
    grants: [],
    schemaGrants: [],
    identityTables: identityTables.map((table) => table.tableName === "sessions"
      ? { ...table, rlsEnabled: false, forceRlsEnabled: false, ownerName: "agentnovas_client_web" }
      : table),
    identityPolicies: identityPolicies.filter((policy) => policy.tableName !== "auth_tokens"),
  });
  assert.ok(findings.some((finding) => finding.code === "IDENTITY_RLS_DISABLED"));
  assert.ok(findings.some((finding) => finding.code === "IDENTITY_RLS_NOT_FORCED"));
  assert.ok(findings.some((finding) => finding.code === "IDENTITY_TABLE_OWNER"));
  assert.ok(findings.some((finding) => finding.code === "IDENTITY_POLICY_MISSING" && finding.message.includes("auth_tokens")));

  const legacyPolicyFindings = evaluatePostgresRolePolicy({
    roles: [],grants: [],schemaGrants: [],identityTables,
    identityPolicies: identityPolicies.map((policy) => policy.tableName === "users"
      && policy.policyName === "users_client_identity_partition"
      ? { ...policy,usingExpression: `${policy.usingExpression} OR current_user='legacy_client'` }
      : policy),
  });
  assert.ok(legacyPolicyFindings.some((finding) => finding.code === "IDENTITY_POLICY_UNSAFE"));
});

test("database role policy distinguishes owner capabilities from runtime grants", () => {
  const ownerFindings = evaluatePostgresRolePolicy({
    roles: [],
    grants: [
      { grantee: "agentnovas_migrator", tableName: "users", privilegeType: "SELECT" },
      { grantee: "agentnovas_migrator", tableName: "invitations", privilegeType: "UPDATE" },
    ],
    schemaGrants: [],
  });
  assert.equal(ownerFindings.some((finding) => finding.code === "IDENTITY_TABLE_GRANT"), false);

  const gatewayFindings = evaluatePostgresRolePolicy({
    roles: [], grants: [], schemaGrants: [],
    identityRoutines: [{
      signature: "client_login_identity(text,text,text)",
      ownerName: "agentnovas_migrator",
      securityDefiner: true,
      config: ["search_path=pg_catalog, public"],
      executeGrantees: ["agentnovas_client_auth", "agentnovas_migrator"],
    }],
  });
  assert.equal(gatewayFindings.some((finding) => (
    finding.code === "IDENTITY_GATEWAY_UNSAFE" && finding.message.includes("client_login_identity")
  )), false);

  const unsafeGatewayFindings = evaluatePostgresRolePolicy({
    roles: [], grants: [], schemaGrants: [],
    identityRoutines: [{
      signature: "client_login_identity(text,text,text)",
      ownerName: "legacy_owner",
      securityDefiner: false,
      config: ["search_path=public, pg_catalog"],
      executeGrantees: ["PUBLIC", "agentnovas_client_web"],
    }],
  });
  assert.ok(unsafeGatewayFindings.some((finding) => finding.code === "IDENTITY_GATEWAY_UNSAFE"));

  const unregisteredGatewayFindings = evaluatePostgresRolePolicy({
    roles: [],grants: [],schemaGrants: [],
    identityRoutines: [{
      signature: "client_unreviewed_identity(text)",ownerName: "agentnovas_migrator",
      securityDefiner: true,config: ["search_path=pg_catalog, public"],
      executeGrantees: ["agentnovas_migrator", "agentnovas_client_web"],
    }],
  });
  assert.ok(unregisteredGatewayFindings.some((finding) => finding.code === "IDENTITY_GATEWAY_UNREGISTERED"));
});

test("least-privilege bootstrap is database-bound and leaves Payment and legacy Research inert", async () => {
  const sql = await read("deploy/postgres/least-privilege-roles.sql");
  const migratorBootstrap = await read("deploy/postgres/bootstrap-migrator.sql");
  assert.match(sql, /current_database\(\)\s*=\s*:'agentnovas_database'/i);
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/i);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/i);
  assert.match(sql, /BEGIN;[\s\S]+COMMIT;/i);
  assert.match(migratorBootstrap, /current_database\(\)\s*=\s*:'agentnovas_database'/i);
  assert.match(migratorBootstrap, /CREATE ROLE agentnovas_migrator LOGIN PASSWORD NULL/i);
  assert.match(migratorBootstrap, /GRANT CREATE,USAGE ON SCHEMA public TO agentnovas_migrator/i);
  assert.match(migratorBootstrap, /ALTER ROLE agentnovas_migrator SET search_path=pg_catalog,public/i);
  assert.doesNotMatch(migratorBootstrap, /migrator_password|replace-me|PASSWORD\s+'[^']+'/i);
  assert.match(sql, /agentnovas_migrator/i);
  assert.match(sql, /ALTER ROLE agentnovas_migrator SET search_path=pg_catalog,public/i);
  assert.match(sql, /GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO agentnovas_migrator/i);
  assert.match(sql, /GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO agentnovas_migrator/i);
  assert.match(sql, /GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO agentnovas_migrator/i);
  assert.match(sql, /agentnovas_payment_worker[^;]+NOLOGIN/is);
  assert.match(sql, /agentnovas_research_worker[^;]+NOLOGIN/is);
  assert.match(sql, /agentnovas_payment_webhook[^;]+LOGIN[^;]+NOBYPASSRLS[^;]+NOINHERIT/is);
  assert.match(sql, /CREATE ROLE %I LOGIN PASSWORD NULL[^']+NOINHERIT/i);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM agentnovas_payment_worker/i);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM agentnovas_research_worker/i);
  assert.doesNotMatch(sql, /GRANT[^;]+TO agentnovas_(?:payment|research)_worker/is);
  assert.doesNotMatch(sql, /GRANT[^;]+ON ALL TABLES[^;]+agentnovas_(?:client|ops|maint)_web/is);
  assert.match(sql, /GRANT SELECT ON platform_demo_accounts_safe TO agentnovas_client_web/i);
  assert.match(sql, /GRANT SELECT, UPDATE ON memberships, official_paper_portfolios TO agentnovas_notification_worker/i);
  assert.match(sql, /GRANT SELECT ON official_paper_positions TO agentnovas_notification_worker/i);
  assert.match(sql, /GRANT SELECT ON notification_preferences TO agentnovas_notification_worker/i);
  assert.match(sql, /GRANT SELECT, INSERT ON membership_access_events TO agentnovas_notification_worker/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON notification_deliveries TO agentnovas_notification_worker/i);
  assert.match(sql, /GRANT INSERT ON audit_logs TO agentnovas_notification_worker/i);
  assert.match(sql, /internal_registration_links,[\s\S]*internal_registration_link_uses[\s\S]*TO agentnovas_ops_web/i);
  assert.match(sql, /GRANT INSERT ON organizations, internal_registration_link_uses\s+TO agentnovas_ops_web/i);
  assert.match(sql, /internal_registration_link_acl_convergence/);
  assert.match(sql, /ALTER FUNCTION public\.protect_internal_registration_link_role\(\)[\s\S]*SET search_path TO pg_catalog, public/i);
  const maintenanceGrantStatements = sql.split(";").filter((statement) => /\bGRANT\b[\s\S]*\bTO agentnovas_maint_web\s*$/i.test(statement.trim()));
  assert.equal(maintenanceGrantStatements.some((statement) => /\binternal_registration_link(?:s|_uses)\b/i.test(statement)), false);
  assert.match(sql, /class\.relkind\s*<>\s*'S'[\s\S]+pg_depend[\s\S]+dependency\.deptype\s+IN\s*\('a','i'\)/i);

  const migrator = await read("deploy/env/migrator.env.example");
  assert.match(migrator, /^DATABASE_URL=postgresql:\/\/agentnovas_migrator:/m);
  assert.match(migrator, /^POSTGRES_MIGRATION_SCHEMA=public$/m);
  assert.doesNotMatch(migrator, /PAYMENT|EXCHANGE|RESEND|LLM|MFA|NOTIFICATION/i);

  const rolePolicy = await read("scripts/release/postgres-role-policy.mjs");
  assert.match(rolePolicy, /"notification_preferences"/);
  assert.match(rolePolicy, /\)::text\[\] AS "policyRoles"/);
  assert.match(rolePolicy, /\)::text\[\] AS "executeGrantees"/);
});

test("Maintenance emergency control receives only the required Paper columns", async () => {
  const sql = await read("deploy/postgres/least-privilege-roles.sql");
  assert.match(sql, /GRANT SELECT \(customer_id, branch_id, status\)\s+ON customer_attributions TO agentnovas_maint_web/i);
  assert.match(sql, /GRANT SELECT \(id, customer_id, access_status\)\s+ON official_paper_portfolios TO agentnovas_maint_web/i);
  assert.match(sql, /GRANT UPDATE \(access_status, updated_at\)\s+ON official_paper_portfolios TO agentnovas_maint_web/i);
  assert.match(sql, /GRANT SELECT \(portfolio_id, status, quantity\)\s+ON official_paper_positions TO agentnovas_maint_web/i);
  assert.match(sql, /GRANT SELECT \(portfolio_id, action, status\)\s+ON official_paper_order_intents TO agentnovas_maint_web/i);
  assert.match(sql, /GRANT UPDATE \(status, rejection_code\)\s+ON official_paper_order_intents TO agentnovas_maint_web/i);
  const tableWideSelectStatements = sql.split(";").filter((statement) => (
    /^\s*GRANT SELECT ON/i.test(statement) && /TO agentnovas_maint_web\s*$/i.test(statement.trim())
  ));
  for (const table of ["customer_attributions", "official_paper_portfolios", "official_paper_positions", "official_paper_order_intents"]) {
    assert.equal(tableWideSelectStatements.some((statement) => new RegExp(`\\b${table}\\b`, "i").test(statement)), false, table);
  }
});

test("recovery script uses non-shell PostgreSQL tools and exact owned cleanup targets", async () => {
  const source = await read("scripts/release/postgres-recovery-rehearsal.mjs");
  assert.match(source, /pg_dump/);
  assert.match(source, /"--enable-row-security"/);
  assert.match(source, /pg_restore/);
  assert.match(source, /createdb/);
  assert.match(source, /dropdb/);
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /rm\s+-rf|DROP\s+SCHEMA|DROP\s+DATABASE/i);
  assert.match(source, /assertControlledRehearsalDatabaseName/);
  assert.match(source, /mkdtemp/);
});

test("触发器读不到自己要读的表时，发布闸门必须拦下来", () => {
  // 客户注册就是这样在生产上整体失效的：0044 给 audit_logs 加了防篡改哈希链，
  // 接链要先读出链尾，而写审计日志的进程角色只有 INSERT——审计表存着全平台的
  // 操作记录，公网进程本就不该读得到。于是任何「插一条审计日志」都 42501。
  //
  // 这一类在开发机上完全看不见：本地用超级用户跑，读一路放行。只有配了最小权限
  // 角色的环境才会暴露，也就是生产。所以它必须由闸门在发布前查出来，而不是由客户
  // 在注册页上撞出来。
  const base = {
    roles: EXPECTED_RELEASE_DATABASE_ROLES.map((roleName) => ({
      roleName, canLogin: true, superuser: false, createRole: false,
      createDatabase: false, replication: false, bypassRls: false,
    })),
    grants: [], schemaGrants: [], memberships: [],
    identityTables: undefined, identityPolicies: undefined, identityRoutines: undefined,
  };

  // 只比较增量：基线里本来就有几条与本用例无关的 finding（例如被停用的
  // payment worker 仍可登录），把它们钉进断言只会让这条用例随无关改动一起红。
  const baseCodes = evaluatePostgresRolePolicy(base).map((item) => item.code);
  assert.ok(!baseCodes.includes("TRIGGER_READ_PRIVILEGE_GAP"), "基线不该有触发器缺口");

  const findings = evaluatePostgresRolePolicy({
    ...base,
    triggerReadGaps: [{
      grantee: "agentnovas_client_web",
      writeTable: "audit_logs",
      functionName: "audit_logs_append_chain",
      readTable: "audit_logs",
      privilege: "SELECT",
    }],
  });
  const gaps = findings.filter((item) => item.code === "TRIGGER_READ_PRIVILEGE_GAP");
  assert.equal(gaps.length, 1);
  findings[0] = gaps[0];
  // 报告必须同时说清「谁」「写哪张表」「触发器要读哪张表」——少任何一个，
  // 看到告警的人都得再去数据库里翻一遍才知道要改什么。
  for (const fragment of ["agentnovas_client_web", "audit_logs", "audit_logs_append_chain", "SELECT"]) {
    assert.match(findings[0].message, new RegExp(fragment));
  }
});

test("审计链触发器必须是 SECURITY DEFINER", async () => {
  // 迁移 0064 的结论不能被后来的迁移悄悄改回去：一旦改回 SECURITY INVOKER，
  // 接链的那条 SELECT 又会跑在调用方权限下，注册再次整体失效。
  const migration = await read("postgres/migrations/0064_audit_chain_runs_as_owner.sql");
  assert.match(migration, /CREATE OR REPLACE FUNCTION audit_logs_append_chain\(\)/);
  assert.match(migration, /SECURITY DEFINER/);
  // SECURITY DEFINER 函数不钉 search_path，调用方可以用同名对象劫持函数体。
  assert.match(migration, /SET search_path/);
});

test("角色脚本拒绝执行时必须以非零码退出", async () => {
  // 原来三处拒绝用的是 \quit，psql 以 0 退出——「脚本跑成功了」和「脚本什么都没做」
  // 在调用方看来完全一样。部署脚本据此判断成功，实际一条 GRANT 都没执行，
  // 而故障要等到某个进程角色第一次写库时才以 42501 的形式冒出来。
  //
  // 我自己就被这个坑误导过一次：拿到一个「脚本显示成功、实际什么都没授」的库，
  // 据此把注册失败的根因判到了错误的地方。
  const script = await read("deploy/postgres/least-privilege-roles.sql");
  assert.match(script, /\\set ON_ERROR_STOP on/, "抛异常要生效，必须先开 ON_ERROR_STOP");
  assert.doesNotMatch(script, /^\s*\\quit\s*$/m, "裸 \\quit 会以 0 退出");
  // 三处守卫（缺参数、库名不符、库名不受控）都要真的报错
  assert.equal((script.match(/RAISE EXCEPTION '(?:agentnovas_database is required|Refusing)/g) ?? []).length, 3);
});
