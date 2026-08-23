import { hash as argon2Hash } from "@node-rs/argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

import { runPostgresMigrations } from "../postgres-migration-runner.mjs";
import {
  assertSafeFixtureDatabaseUrl,
  assertSafeQualitySchema,
  postgresUrlForSchema,
} from "./quality-policy.mjs";

const LEGAL_DOCUMENT_TYPES = [
  "service_entity",
  "jurisdiction",
  "privacy",
  "terms",
  "risk_disclosure",
  "simulated_performance_fee_opinion",
  "refund_policy",
];

const ROLE_PERMISSIONS = {
  client: [
    "client.membership.view",
    "client.membership.order",
    "client.credits.view",
    "client.paper.view",
    "client.paper.manage",
    "client.wallet.view",
  ],
  clientSecurity: [
    "client.membership.view",
    "client.membership.order",
    "client.credits.view",
    "client.paper.view",
    "client.paper.manage",
    "client.wallet.view",
  ],
  operationsMaker: [
    "ops.customers.view",
    "ops.organization.view",
    "ops.membership_orders.view",
    "ops.membership_orders.evidence",
    "ops.credits.view",
    "ops.performance_fees.view",
    "ops.performance_fees.payment_evidence",
    "ops.deposits.view",
    "ops.ledger.view",
  ],
  operationsChecker: [
    "ops.customers.view",
    "ops.customers.pii_contact",
    "ops.customers.pii_security",
    "ops.customers.pii_financial",
    "ops.customers.pii_trading",
    "ops.customers.export",
    "ops.invitations.view",
    "ops.invitations.manage",
    "ops.membership_orders.view",
    "ops.membership_orders.approve",
    "ops.credits.view",
    "ops.performance_fees.view",
    "ops.performance_fees.approve",
    "ops.performance_fees.payment_approve",
    "ops.approvals.view",
    "ops.approvals.decide",
  ],
  maintenanceAdmin: [
    "maint.llm_profiles.manage",
    "maint.agent_bindings.manage",
    "maint.payment_integrations.manage",
    "maint.email_integrations.manage",
    "maint.feature_flags.manage",
    "maint.system_health.view",
    "maint.ai_usage.view",
    "maint.emergency_pause.execute",
    "maint.audit.view",
    "maint.roles.manage",
    "maint.roles.approve_sensitive",
    "maint.follow_policy.view",
    "maint.follow_policy.manage",
    "maint.demo_exchanges.view",
    "maint.demo_exchanges.manage",
    "maint.demo_exchanges.verify",
    "maint.demo_exchanges.kill",
    "maint.commercial_disclosures.view",
    "maint.commercial_disclosures.submit",
    "maint.commercial_disclosures.approve",
    "maint.releases.view",
    "maint.releases.manage",
    "maint.releases.approve",
    "maint.configuration_versions.view",
    "maint.configuration_versions.manage",
    "maint.configuration_versions.approve",
    "maint.configuration_versions.activate",
  ],
};

const IDENTITY_DEFINITIONS = {
  client: { audience: "client", domain: "agentnovas.com", cookieName: "rc_client_session", legacyRole: "customer", scope: "SELF" },
  clientSecurity: { audience: "client", domain: "agentnovas.com", cookieName: "rc_client_session", legacyRole: "customer", scope: "SELF", seedSession: false },
  operationsMaker: { audience: "operations", domain: "zht.agentnovas.com", cookieName: "rc_ops_session", legacyRole: "employee", scope: "ORGANIZATION" },
  operationsChecker: { audience: "operations", domain: "zht.agentnovas.com", cookieName: "rc_ops_session", legacyRole: "manager", scope: "ORGANIZATION" },
  maintenanceAdmin: { audience: "maintenance", domain: "xm.agentnovas.com", cookieName: "rc_maint_session", legacyRole: "hq_admin", scope: "PLATFORM" },
};

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

function qualityResearchFixtureIds(schema) {
  const suffix = schema.slice(-12);
  return {
    runId: `quality-run-${suffix}`,
    candidateId: `quality-candidate-${suffix}`,
    exchangeAccountId: `quality-exchange-${suffix}`,
  };
}

function assertLoopbackBaseUrls(baseUrls) {
  for (const audience of ["client", "operations", "maintenance"]) {
    const url = new URL(String(baseUrls?.[audience] ?? ""));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/") {
      throw new Error(`Unsafe ${audience} quality base URL`);
    }
  }
}

async function passwordHash(password) {
  return argon2Hash(password, {
    algorithm: 2,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
}

async function insertRole(client, input) {
  await client.query(`
    INSERT INTO roles (
      id, application_id, code, name, kind, created_organization_id,
      applies_to_organization_id, status, is_system
    ) VALUES ($1,$2,$3,$4,'custom',$5,$5,'published',false)
  `, [input.roleId, input.audience, input.roleCode, input.roleName, input.organizationId]);
  for (const permissionKey of input.permissions) {
    await client.query(`
      INSERT INTO role_permissions (
        id, role_id, permission_key, scope, scope_organization_ids_json
      ) VALUES ($1,$2,$3,$4,$5::jsonb)
    `, [
      `${input.roleId}:${permissionKey}`,
      input.roleId,
      permissionKey,
      input.scope,
      JSON.stringify(input.organizationId ? [input.organizationId] : []),
    ]);
  }
}

async function seedFixture(pool, outputDirectory, schema, baseUrls) {
  const client = await pool.connect();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 60_000);
  const organizationId = `quality-org-${schema.slice(-16)}`;
  const identities = {};
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO organizations (id,type,name,status)
      VALUES ($1,'branch','Quality E2E Branch','active')
    `, [organizationId]);

    for (const [name, definition] of Object.entries(IDENTITY_DEFINITIONS)) {
      const userId = `quality-${name.toLowerCase()}-${schema.slice(-12)}`;
      const email = `${name.toLowerCase()}-${schema.slice(-10)}@quality.invalid`;
      const password = `Qe2e!${randomSecret(18)}`;
      const token = `qe2e_token_${randomSecret(32)}`;
      const roleId = `quality-role-${name.toLowerCase()}-${schema.slice(-10)}`;
      const internal = definition.audience !== "client";
      await client.query(`
        INSERT INTO users (
          id,email,password_hash,email_verified_at,role,organization_id,status,
          locale,timezone,username,nickname
        ) VALUES ($1,$2,$3,$4,$5,$6,'active','zh-CN','Asia/Shanghai',$7,$8)
      `, [
        userId,
        email,
        await passwordHash(password),
        now.toISOString(),
        definition.legacyRole,
        internal ? organizationId : null,
        `quality_${name.toLowerCase()}`,
        `Quality ${name}`,
      ]);
      await insertRole(client, {
        roleId,
        roleCode: `quality_${name.toLowerCase()}`,
        roleName: `Quality ${name}`,
        audience: definition.audience,
        organizationId: definition.audience === "operations" ? organizationId : null,
        scope: definition.scope,
        permissions: ROLE_PERMISSIONS[name],
      });
      await client.query(`
        INSERT INTO user_role_assignments (
          id,user_id,role_id,application_id,organization_id,status,effective_at,
          reason,scope_organization_ids_json
        ) VALUES ($1,$2,$3,$4,$5,'active',$6,'isolated quality fixture',$7::jsonb)
      `, [
        `quality-assignment-${name.toLowerCase()}-${schema.slice(-10)}`,
        userId,
        roleId,
        definition.audience,
        definition.audience === "operations" ? organizationId : null,
        now.toISOString(),
        JSON.stringify(definition.audience === "operations" ? [organizationId] : []),
      ]);
      if (definition.seedSession !== false) {
        await client.query(`
          INSERT INTO sessions (
            id,user_id,token_hash,app_audience,expires_at,mfa_level,mfa_verified_at,
            last_seen_at,idle_expires_at,absolute_expires_at,ip_address,user_agent
          ) VALUES (
            $1,$2,$3,$4,$5::text,$6,$7::timestamptz,$7::timestamptz,
            $5::timestamptz,$5::timestamptz,'127.0.0.1','AgentNovas Quality E2E'
          )
        `, [
          randomUUID(),
          userId,
          sha256(token),
          definition.audience,
          expiresAt.toISOString(),
          internal ? "totp" : "none",
          internal ? now.toISOString() : null,
        ]);
      }
      identities[name] = {
        userId,
        email,
        password,
        token,
        audience: definition.audience,
        domain: definition.domain,
        cookieName: definition.cookieName,
        storageState: join(outputDirectory, `${name}.storage-state.json`),
      };
    }

    await client.query(`
      INSERT INTO customer_attributions (
        id,customer_id,source,status,branch_id,manager_id,employee_id,effective_at,reason
      ) VALUES ($1,$2,'quality_fixture','active',$3,$4,$5,$6,'isolated quality fixture')
    `, [
      `quality-attribution-${schema.slice(-12)}`,
      identities.client.userId,
      organizationId,
      identities.operationsChecker.userId,
      identities.operationsMaker.userId,
      now.toISOString(),
    ]);

    const aiProfileId = `quality-ai-profile-${schema.slice(-12)}`;
    const aiRevisionId = `quality-ai-revision-${schema.slice(-12)}`;
    const aiCreditAccountId = `quality-ai-credits-${schema.slice(-12)}`;
    const aiSuccessReservationId = `quality-ai-reservation-success-${schema.slice(-10)}`;
    const aiFailureReservationId = `quality-ai-reservation-failure-${schema.slice(-10)}`;
    await client.query(`
      INSERT INTO llm_profiles(
        id,name,provider_name,base_url,model_name,encrypted_api_key,masked_api_key,
        enabled,current_revision_id,created_by_user_id,updated_by_user_id
      ) VALUES ($1,'Quality AI profile','Quality Provider','https://quality.invalid/v1',
        'quality-model','quality-fixture-non-secret','***fixture',true,$2,$3,$3)
    `, [aiProfileId, aiRevisionId, identities.maintenanceAdmin.userId]);
    await client.query(`
      INSERT INTO llm_profile_revisions(
        id,profile_id,revision_number,name,provider_name,base_url,model_name,
        encrypted_api_key,masked_api_key,enabled,created_by_user_id
      ) VALUES ($1,$2,1,'Quality AI revision','Quality Provider','https://quality.invalid/v1',
        'quality-model','quality-fixture-non-secret','***fixture',true,$3)
    `, [aiRevisionId, aiProfileId, identities.maintenanceAdmin.userId]);
    await client.query(`
      INSERT INTO ai_credit_accounts(id,user_id,available_credits,reserved_credits)
      VALUES ($1,$2,100,0)
    `, [aiCreditAccountId, identities.client.userId]);
    await client.query(`
      INSERT INTO ai_credit_reservations(
        id,account_id,estimated_credits,settled_credits,status,idempotency_key,expires_at
      ) VALUES
        ($1,$3,9,7,'settled',$4,$6),
        ($2,$3,5,NULL,'released',$5,$6)
    `, [
      aiSuccessReservationId,
      aiFailureReservationId,
      aiCreditAccountId,
      `quality-ai-success-reservation-${schema}`,
      `quality-ai-failure-reservation-${schema}`,
      new Date(now.getTime() + 15 * 60_000).toISOString(),
    ]);
    await client.query(`
      INSERT INTO client_ai_inference_requests(
        id,user_id,operation,idempotency_key,payload_sha256,profile_revision_id,status,
        reservation_id,result_json,error_code,error_message,error_status,
        provider_request_id,usage_id,input_tokens,output_tokens,request_id,
        organization_id,organization_attribution_mode,created_at,completed_at,updated_at
      ) VALUES
        ($1,$2,'assistant_message',$3,$4,$5,'succeeded',$6,'{"quality":true}'::jsonb,
          NULL,NULL,NULL,$7,$7,120,30,$8,$9,'captured_at_request',$10,$10,$10),
        ($11,$2,'strategy_generation',$12,$13,$5,'failed',$14,NULL,
          'QUALITY_PROVIDER_UNAVAILABLE','Synthetic quality failure',503,NULL,NULL,NULL,NULL,
          $15,$9,'captured_at_request',$16,$16,$16)
    `, [
      `quality-ai-success-${schema.slice(-12)}`,
      identities.client.userId,
      `quality-ai-success-request-${schema}`,
      sha256(`quality-ai-success-payload-${schema}`),
      aiRevisionId,
      aiSuccessReservationId,
      `quality-provider-request-${schema}`,
      `quality-ai-request-id-success-${schema}`,
      organizationId,
      new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
      `quality-ai-failure-${schema.slice(-12)}`,
      `quality-ai-failure-request-${schema}`,
      sha256(`quality-ai-failure-payload-${schema}`),
      aiFailureReservationId,
      `quality-ai-request-id-failure-${schema}`,
      new Date(now.getTime() - 60 * 60_000).toISOString(),
    ]);

    for (const [index, documentType] of LEGAL_DOCUMENT_TYPES.entries()) {
      const contentMarkdown = `# Quality fixture: ${documentType}\n\nSynthetic legal content used only by the isolated browser test. It is not legal advice or a production document.`;
      await client.query(`
        INSERT INTO commercial_legal_document_versions (
          id,document_type,version,content_sha256,content_locale,content_markdown,
          status,approved_by_user_id,approved_at,effective_at
        ) VALUES ($1,$2,1,$3,'en',$4,'active',$5,$6,$6)
      `, [
        `quality-legal-${index + 1}-${schema.slice(-10)}`,
        documentType,
        sha256(contentMarkdown),
        contentMarkdown,
        identities.maintenanceAdmin.userId,
        now.toISOString(),
      ]);
    }

    for (const index of LEGAL_DOCUMENT_TYPES.keys()) {
      await client.query(`
        INSERT INTO commercial_legal_acceptances (
          id,user_id,document_version_id,ip_address,user_agent
        ) VALUES ($1,$2,$3,'127.0.0.1','AgentNovas Quality E2E')
      `, [
        `quality-legal-acceptance-${index + 1}-${schema.slice(-8)}`,
        identities.client.userId,
        `quality-legal-${index + 1}-${schema.slice(-10)}`,
      ]);
    }

    const researchFixture = qualityResearchFixtureIds(schema);
    const candidateSpecification = {
      schemaVersion: 3,
      name: "Quality BTC trend candidate",
      market: "usdt_perpetual",
      marginMode: "isolated",
      leverage: 1,
      symbol: "BTCUSDT",
      timeframe: "1h",
      direction: "long_only",
      legs: {
        long: {
          entry: { all: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bullish" }] },
          exit: { any: [{ type: "ema_cross", fastPeriod: 20, slowPeriod: 60, direction: "bearish" }] },
          stopLossPct: 2,
          takeProfitPct: 4,
        },
      },
      risk: {
        positionSizePct: 3,
        maxDrawdownPct: 10,
        maxDailyLossPct: 2,
        maxConsecutiveLosses: 3,
      },
    };
    await client.query(`
      INSERT INTO strategy_research_runs (
        id,owner_user_id,conversation_id,exchange_account_id,mode,stage,status,progress,
        brief_json,agent_role_snapshot_json,result_json,final_conclusion,idempotency_key,
        candidate_budget,backtest_budget,model_call_budget,backtests_used,model_calls_used,
        started_at,completed_at
      ) VALUES (
        $1,$2,NULL,$3,'standard','completed','completed',100,
        $4::jsonb,'{}'::jsonb,$5::jsonb,'QUALIFIED',$6,
        6,60,24,60,24,$7,$7
      )
    `, [
      researchFixture.runId,
      identities.client.userId,
      researchFixture.exchangeAccountId,
      JSON.stringify({
        name: "Quality editable candidate research",
        target: { instrumentId: "BTC-USDT-SWAP", symbol: "BTCUSDT", timeframe: "1h", direction: "long_only" },
      }),
      JSON.stringify({ qualityFixture: true }),
      `quality-research-${schema}`,
      now.toISOString(),
    ]);
    await client.query(`
      INSERT INTO strategy_candidates (
        id,run_id,candidate_key,strategy_family,source_role,dsl_json,status,rank,score,
        rejection_reasons_json,validation_label
      ) VALUES ($1,$2,'quality-primary','EMA trend','proposal_a',$3::jsonb,'qualified',1,88.5,'[]'::jsonb,'STANDARD_VERIFIED')
    `, [researchFixture.candidateId, researchFixture.runId, JSON.stringify(candidateSpecification)]);
    await client.query(`
      INSERT INTO strategy_evaluations (
        id,run_id,candidate_id,evaluation_kind,window_index,period_start,period_end,
        metrics_json,data_quality_json,parameter_set_sha256,data_slice_sha256,
        backtest_engine_version,cost_scenario,passed,is_final_holdout
      ) VALUES ($1,$2,$3,'holdout',0,$4,$5,$6::jsonb,$7::jsonb,$8,$9,'quality-engine-v1','quality-cost-v1',true,true)
    `, [
      `quality-evaluation-${schema.slice(-12)}`,
      researchFixture.runId,
      researchFixture.candidateId,
      new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
      now.toISOString(),
      JSON.stringify({ netReturnPct: 12.5, maxDrawdownPct: 7.25, profitFactor: 1.8, sampleSize: 120 }),
      JSON.stringify({ qualityFixture: true }),
      sha256(JSON.stringify(candidateSpecification)),
      sha256(`quality-data-${schema}`),
    ]);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (const [name, identity] of Object.entries(identities)) {
    const cookies = IDENTITY_DEFINITIONS[name].seedSession === false ? [] : [{
      name: identity.cookieName,
      value: identity.token,
      domain: identity.domain,
      path: "/",
      expires: Math.floor(expiresAt.getTime() / 1000),
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    }];
    if (identity.audience === "client" && cookies.length) cookies.push({ ...cookies[0], name: "an_session" });
    await writeFile(identity.storageState, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
  }
  const runtime = {
    schema,
    externalWritesEnabled: false,
    organizationId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    baseUrls,
    identities,
    researchFixture: qualityResearchFixtureIds(schema),
  };
  await writeFile(join(outputDirectory, "runtime.json"), JSON.stringify(runtime, null, 2), { mode: 0o600 });
  return runtime;
}

export async function prepareQualityDatabaseFixture({
  adminDatabaseUrl,
  schema,
  outputDirectory,
  baseUrls = {
    client: "http://127.0.0.1:3000",
    operations: "http://127.0.0.1:3001",
    maintenance: "http://127.0.0.1:3002",
  },
}) {
  const safeAdminUrl = assertSafeFixtureDatabaseUrl(adminDatabaseUrl).toString();
  assertSafeQualitySchema(schema);
  assertLoopbackBaseUrls(baseUrls);
  const adminPool = new pg.Pool({ connectionString: safeAdminUrl, max: 1, application_name: "agentnovas-quality-admin" });
  let created = false;
  try {
    const existing = await adminPool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema]);
    if (existing.rowCount) throw new Error(`Quality fixture schema already exists: ${schema}`);
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const applicationDatabaseUrl = postgresUrlForSchema(safeAdminUrl, schema).toString();
    const pool = new pg.Pool({ connectionString: applicationDatabaseUrl, max: 2, application_name: "agentnovas-quality-fixture" });
    try {
      await runPostgresMigrations(pool, { commitSha: "quality-e2e-fixture" });
      const runtime = await seedFixture(pool, outputDirectory, schema, baseUrls);
      return { ...runtime, applicationDatabaseUrl };
    } finally {
      await pool.end();
    }
  } catch (error) {
    if (created) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    throw error;
  } finally {
    await adminPool.end();
  }
}

export async function cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema }) {
  const safeAdminUrl = assertSafeFixtureDatabaseUrl(adminDatabaseUrl).toString();
  assertSafeQualitySchema(schema);
  const adminPool = new pg.Pool({ connectionString: safeAdminUrl, max: 1, application_name: "agentnovas-quality-cleanup" });
  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await adminPool.end();
  }
}
