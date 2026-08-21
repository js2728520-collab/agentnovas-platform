import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertControlledRehearsalDatabaseName,
  assertLoopbackPostgresUrl,
  assertRestorableMigrationEvidence,
  assertRecoveryRehearsalAuthorized,
  databaseConnectionOptions,
} from "../scripts/release/postgres-recovery-rehearsal.mjs";
import {
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
  const safeRoles = EXPECTED_RELEASE_DATABASE_ROLES.map((roleName) => ({
    roleName,
    canLogin: !["agentnovas_payment_worker", "agentnovas_research_worker"].includes(roleName),
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
});

test("database role policy verifies Client identity RLS ownership and restrictive policies", () => {
  const identityTables = [
    "users",
    "sessions",
    "auth_tokens",
    "user_mfa_totp_credentials",
    "user_mfa_recovery_codes",
  ].map((tableName) => ({ tableName, rlsEnabled: true, ownerName: "agentnovas_migrator" }));
  const identityPolicies = identityTables.flatMap(({ tableName }) => {
    const rowContract = tableName === "users" ? "role = 'customer'"
      : tableName === "sessions" ? "app_audience = 'client' AND account.role = 'customer'"
        : tableName === "auth_tokens" ? "token_audience = 'client' AND account.role = 'customer'"
          : "account.role = 'customer'";
    const baseName = tableName === "user_mfa_totp_credentials" ? "mfa_totp_identity_base_access"
      : tableName === "user_mfa_recovery_codes" ? "mfa_recovery_identity_base_access"
        : `${tableName}_identity_base_access`;
    return [{
      tableName,policyName: `${tableName}_client_identity_partition`,restrictive: true,command: "*",policyRoles: ["PUBLIC"],
      usingExpression: `current_user = 'agentnovas_client_web' AND ${rowContract}`,
      checkExpression: `current_user = 'agentnovas_client_web' AND ${rowContract}`,
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
      ? { ...table, rlsEnabled: false, ownerName: "agentnovas_client_web" }
      : table),
    identityPolicies: identityPolicies.filter((policy) => policy.tableName !== "auth_tokens"),
  });
  assert.ok(findings.some((finding) => finding.code === "IDENTITY_RLS_DISABLED"));
  assert.ok(findings.some((finding) => finding.code === "IDENTITY_TABLE_OWNER"));
  assert.ok(findings.some((finding) => finding.code === "IDENTITY_POLICY_MISSING" && finding.message.includes("auth_tokens")));
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
      config: ['search_path="public",pg_catalog'],
      executeGrantees: ["agentnovas_client_auth", "agentnovas_migrator"],
    }],
  });
  assert.equal(gatewayFindings.some((finding) => (
    finding.code === "IDENTITY_GATEWAY_UNSAFE" && finding.message.includes("client_login_identity")
  )), false);
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
  assert.match(sql, /agentnovas_payment_worker[^;]+NOLOGIN/is);
  assert.match(sql, /agentnovas_research_worker[^;]+NOLOGIN/is);
  assert.match(sql, /CREATE ROLE %I LOGIN PASSWORD NULL[^']+NOINHERIT/i);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM agentnovas_payment_worker/i);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM agentnovas_research_worker/i);
  assert.doesNotMatch(sql, /GRANT[^;]+TO agentnovas_(?:payment|research)_worker/is);
  assert.doesNotMatch(sql, /GRANT[^;]+ON ALL TABLES[^;]+agentnovas_(?:client|ops|maint)_web/is);
  assert.match(sql, /GRANT SELECT ON platform_demo_accounts_safe TO agentnovas_client_web/i);
  assert.match(sql, /class\.relkind\s*<>\s*'S'[\s\S]+pg_depend[\s\S]+dependency\.deptype\s+IN\s*\('a','i'\)/i);

  const migrator = await read("deploy/env/migrator.env.example");
  assert.match(migrator, /^DATABASE_URL=postgresql:\/\/agentnovas_migrator:/m);
  assert.match(migrator, /^POSTGRES_MIGRATION_SCHEMA=public$/m);
  assert.doesNotMatch(migrator, /PAYMENT|EXCHANGE|RESEND|LLM|MFA|NOTIFICATION/i);

  const rolePolicy = await read("scripts/release/postgres-role-policy.mjs");
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
  assert.match(source, /pg_restore/);
  assert.match(source, /createdb/);
  assert.match(source, /dropdb/);
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /rm\s+-rf|DROP\s+SCHEMA|DROP\s+DATABASE/i);
  assert.match(source, /assertControlledRehearsalDatabaseName/);
  assert.match(source, /mkdtemp/);
});
