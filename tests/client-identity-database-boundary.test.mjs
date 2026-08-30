import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  expectedWebDatabaseRole,
  isolatedQualityDatabaseRoleBypass,
  resolveWebDatabaseConfiguration,
} from "../lib/postgres.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Client identity RLS and capability gateways partition internal and cross-customer identity", async () => {
  const migration = await read("postgres/migrations/0040_client_identity_rls.sql");
  const hardening = await read("postgres/migrations/0043_client_identity_gateway_hardening.sql");
  for (const table of ["users", "sessions", "auth_tokens", "user_mfa_totp_credentials", "user_mfa_recovery_codes"]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, "i"));
    assert.match(hardening, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, "i"));
  }
  assert.match(hardening, /current_user IN \('agentnovas_migrator','agentnovas_ops_web','agentnovas_maint_web'/i);
  assert.doesNotMatch(hardening, /current_user\s*=\s*'agentnovas_client_web'|current_setting|set_config|request\.|jwt|session_user/i);
  assert.match(migration, /users\.role\s*=\s*'customer'|role\s*=\s*'customer'/i);
  assert.match(migration, /app_audience\s*=\s*'client'/i);
  assert.match(migration, /token_audience\s*=\s*'client'/i);
  assert.match(migration, /SECURITY DEFINER/i);
  assert.match(hardening, /SET search_path TO pg_catalog, %I/i);
  assert.match(hardening, /REVOKE ALL PRIVILEGES ON TABLE %s FROM %I/i);
  assert.match(hardening, /REVOKE ALL ON FUNCTION %s FROM %I/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION (?:public\.)?client_registration_attribution\(text,text\) FROM PUBLIC/i);
  for (const gateway of ["client_login_identity", "client_session_identity", "client_change_password", "client_mfa_credential"]) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${gateway}`));
  }
});

test("Client deploy grants revoke direct identity and invitation access in favor of gateways", async () => {
  const grants = await read("deploy/postgres/least-privilege-roles.sql");
  const broadClientWrites = grants.split(";").filter((statement) => (
    /GRANT INSERT, UPDATE ON/i.test(statement) && /TO agentnovas_client_web\s*$/i.test(statement.trim())
  ));
  for (const table of ["users", "sessions", "auth_tokens", "user_mfa_totp_credentials", "user_mfa_recovery_codes"]) {
    assert.equal(broadClientWrites.some((statement) => new RegExp(`\\b${table}\\b`, "i").test(statement)), false, table);
  }
  const clientSelect = grants.split(";").find((statement) => /GRANT SELECT ON[\s\S]+TO agentnovas_client_web\s*$/i.test(statement.trim())) ?? "";
  for (const table of ["users", "sessions", "auth_tokens", "user_mfa_totp_credentials", "user_mfa_recovery_codes", "invitations"]) {
    assert.doesNotMatch(clientSelect, new RegExp(`\\b${table}\\b`, "i"));
  }
  assert.match(grants, /GRANT EXECUTE ON FUNCTION[\s\S]+client_registration_attribution\(text,text\)[\s\S]+client_session_identity\(text,timestamptz\)[\s\S]+TO agentnovas_client_web/i);
  assert.doesNotMatch(grants, /GRANT DELETE ON[^;]+\b(?:sessions|auth_tokens)\b[^;]+TO agentnovas_client_web/i);
  assert.match(grants, /identity_gateway_acl_convergence[\s\S]+REVOKE ALL ON FUNCTION %s FROM %I/i);
  assert.match(grants, /BEGIN;[\s\S]+COMMIT;/);
});

test("Client registration resolves internal reporting metadata only through the bounded function", async () => {
  const source = await read("lib/client-registration-service.ts");
  assert.match(source, /client_registration_attribution\(\$1,\$2\)/);
  assert.doesNotMatch(source, /WITH RECURSIVE reporting_chain/);
  assert.doesNotMatch(source, /JOIN users AS parent/);
});

test("Web pools bind audience roles and only allow the isolated loopback quality schema exception", async () => {
  assert.equal(expectedWebDatabaseRole({ RIVERTON_APP_AUDIENCE: "client" }), "agentnovas_client_web");
  assert.equal(expectedWebDatabaseRole({ RIVERTON_APP_AUDIENCE: "operations" }), "agentnovas_ops_web");
  assert.equal(expectedWebDatabaseRole({ RIVERTON_APP_AUDIENCE: "maintenance" }), "agentnovas_maint_web");
  const disabled = {
    PAYMENT_WORKER_ENABLED: "false",PAYMENT_PROVIDER_TESTS_ENABLED: "false",NOTIFICATION_WORKER_ENABLED: "false",
    NOTIFICATION_EMAIL_SEND_ENABLED: "false",DEMO_EXECUTION_WORKER_ENABLED: "false",
    PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED: "false",PLATFORM_DEMO_VERIFICATION_ENABLED: "false",
    STRATEGY_RESEARCH_ENABLED: "false",STRATEGY_RUNTIME_ENABLED: "false",
  };
  const schema = "quality_e2e_identity_boundary";
  const url = `postgresql://admin@127.0.0.1/postgres?options=-csearch_path%3D${schema}`;
  assert.equal(isolatedQualityDatabaseRoleBypass(url, { ...disabled,QUALITY_E2E_SCHEMA: schema }), true);
  assert.equal(isolatedQualityDatabaseRoleBypass(url.replace("127.0.0.1", "db.example.test"), { ...disabled,QUALITY_E2E_SCHEMA: schema }), false);
  assert.equal(isolatedQualityDatabaseRoleBypass(url, { ...disabled,QUALITY_E2E_SCHEMA: schema,PLATFORM_DEMO_EXTERNAL_WRITES_ENABLED: "true" }), false);
  assert.throws(
    () => resolveWebDatabaseConfiguration({ DATABASE_URL: "postgresql://legacy@127.0.0.1/agentnovas" }),
    /RIVERTON_APP_AUDIENCE/i,
  );
  assert.throws(
    () => resolveWebDatabaseConfiguration({ RIVERTON_APP_AUDIENCE: "unknown", DATABASE_URL: "postgresql://legacy@127.0.0.1/agentnovas" }),
    /RIVERTON_APP_AUDIENCE/i,
  );
  assert.throws(
    () => resolveWebDatabaseConfiguration({ RIVERTON_APP_AUDIENCE: "client", DATABASE_URL: "postgresql://legacy@127.0.0.1/agentnovas" }),
    /数据库角色.*audience/i,
  );
  assert.deepEqual(
    resolveWebDatabaseConfiguration({
      RIVERTON_APP_AUDIENCE: "client",
      DATABASE_URL: "postgresql://agentnovas_client_web@127.0.0.1/agentnovas",
    }),
    {
      connectionString: "postgresql://agentnovas_client_web@127.0.0.1/agentnovas",
      expectedRole: "agentnovas_client_web",
      qualityRoleBypass: false,
    },
  );
  const source = await read("lib/postgres.ts");
  assert.doesNotMatch(source, /expectedRole \? businessDatabaseUrl\(\) : researchDatabaseUrl\(\)/);
  assert.match(source, /resolveWebDatabaseConfiguration/);
  assert.match(source, /CLIENT_AUTH_DATABASE_URL/);
  assert.match(source, /agentnovas_client_auth/);
});

test("Client production env documents the non-shared MFA key requirement", async () => {
  const environment = await read("deploy/env/client.env.example");
  assert.match(environment, /MFA_TOTP_ENCRYPTION_KEY=.*at-least-32-characters/);
  assert.match(environment, /MFA_TOTP_ENCRYPTION_KEY[^\n]+must be identical across Client replicas/i);
  assert.match(environment, /must not reuse[^\n]+AI Gateway credential/i);
  assert.doesNotMatch(environment, /LLM_PROFILE_ENCRYPTION_KEY/);
});

test("Client commercial writes use the authenticated subject without reopening users", async () => {
  const commercial = await read("lib/commercial-membership-service.ts");
  const start = commercial.indexOf("export async function acceptCurrentCommercialLegalDocuments");
  const end = commercial.indexOf("export async function createMembershipOrder", start);
  const acceptance = commercial.slice(start, end);
  assert.match(acceptance, /pg_advisory_xact_lock/);
  assert.doesNotMatch(acceptance, /FROM users|UPDATE users|INTO users/i);

  const deposits = await read("app/api/wallet/deposit-orders/route.client.ts");
  assert.match(deposits, /user\.organizationId/);
  assert.doesNotMatch(deposits, /FROM users/i);
});
