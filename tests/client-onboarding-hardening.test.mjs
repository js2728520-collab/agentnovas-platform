import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { normalizeProfilePhoneUpdate } from "../lib/account-profile.ts";
import {
  consumeClientRegistrationRateLimit,
  registerInvitedClient,
} from "../lib/client-registration-service.ts";
import { acceptCurrentCommercialLegalDocuments } from "../lib/commercial-membership-service.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `client_onboarding_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 12,
  options: `-c search_path=${schema}`,
});

const digest = (value) => createHash("sha256").update(value).digest("hex");
const legalTypes = [
  "service_entity", "jurisdiction", "privacy", "terms", "risk_disclosure",
  "simulated_performance_fee_opinion", "refund_policy",
];

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const migrationNames = (await readdir(new URL("../postgres/migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 30)
    .sort();
  for (const name of migrationNames) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${name}`, import.meta.url), "utf8"));
  }
  // 0060 给组合加 book 维度（模拟盘/实盘各一本账）。开通会员时建组合的语句按
  // (membership_id, strategy_code, book) 判重，缺了这一列会直接报列不存在。
  await pool.query(await readFile(
    new URL("../postgres/migrations/0060_live_portfolio_book.sql", import.meta.url), "utf8"));
  const registrationMigration = await readFile(
    new URL("../postgres/migrations/0034_client_registration_rate_limit.sql", import.meta.url),
    "utf8",
  );
  await pool.query(registrationMigration);
  await pool.query(registrationMigration);
  const identityMigration = (await readFile(
    new URL("../postgres/migrations/0040_client_identity_rls.sql", import.meta.url),
    "utf8",
  )).replaceAll("pg_catalog, public", `pg_catalog, "${schema}"`)
    .replaceAll("public.", `"${schema}".`);
  await pool.query(identityMigration);
  await pool.query(`
    INSERT INTO organizations(id,type,name) VALUES('registration-org','headquarters','Registration Org');
    INSERT INTO users(id,email,password_hash,role,organization_id,status) VALUES
      ('registration-issuer','issuer@example.test','x','hq_admin','registration-org','active');
  `);
  for (const [index, documentType] of legalTypes.entries()) {
    const content = `# ${documentType}\n\n${"这是受控测试使用的商业披露正文，内容仅用于验证版本确认与试用激活顺序。".repeat(4)}`;
    await pool.query(`
      INSERT INTO commercial_legal_document_versions(
        id,document_type,version,content_sha256,content_locale,content_markdown,
        status,approved_by_user_id,approved_at,effective_at
      ) VALUES($1,$2,1,$3,'zh-CN',$4,'active','registration-issuer',$5,$5)
    `, [
      `registration-legal-${index}`, documentType, digest(content), content,
      "2026-08-20T00:00:00.000Z",
    ]);
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("profile phone updates use the login normalizer and cannot clear the only usable identifier", () => {
  assert.equal(normalizeProfilePhoneUpdate("+1 (415) 867-5309", {
    email: "phone-deadbeef@unverified.agentnovas.local",
    username: null,
  }), "+14158675309");
  assert.throws(() => normalizeProfilePhoneUpdate("", {
    email: "phone-deadbeef@unverified.agentnovas.local",
    username: null,
  }), (error) => error.code === "LOGIN_IDENTIFIER_REQUIRED" && error.status === 422);
  assert.equal(normalizeProfilePhoneUpdate("", {
    email: "customer@example.test",
    username: null,
  }), null);
});

test("registration rate limits phone and network buckets independently", async () => {
  const now = new Date("2026-08-21T00:00:00.000Z");
  const phoneResults = [];
  for (let index = 0; index < 6; index += 1) {
    phoneResults.push(await consumeClientRegistrationRateLimit(pool, {
      phone: "+14158675309",
      connectionBucketKey: `ip:203.0.113.${index + 1}`,
      now,
    }));
  }
  assert.deepEqual(phoneResults.map(({ allowed }) => allowed), [true, true, true, true, true, false]);

  const networkResults = [];
  for (let index = 0; index < 31; index += 1) {
    networkResults.push(await consumeClientRegistrationRateLimit(pool, {
      phone: `+86139000${String(index).padStart(4, "0")}`,
      connectionBucketKey: "ip:198.51.100.9",
      now,
    }));
  }
  assert.equal(networkResults.at(-1).allowed, false);
  const actions = (await pool.query(
    `SELECT DISTINCT action FROM auth_rate_limit_buckets ORDER BY action`,
  )).rows.map(({ action }) => action);
  assert.deepEqual(actions, ["register"]);
});

test("a public one-time invitation has one atomic pending-trial winner, then disclosure activates all three paper cards", async () => {
  const code = "ONE-TIME-CLIENT-INVITE";
  await pool.query(`
    INSERT INTO invitations(id,code_hash,kind,issuer_user_id,organization_id,status)
    VALUES('single-invite',$1,'public_pool_single_use','registration-issuer','registration-org','active')
  `, [digest(code)]);

  const base = {
    codeHash: digest(code),
    passwordHash: "argon2id-test-hash",
    now: new Date("2026-08-21T01:00:00.000Z"),
    ipAddress: "203.0.113.20",
    userAgent: "client-onboarding-test",
  };
  const attempts = await Promise.allSettled([
    registerInvitedClient(pool, {
      ...base,
      phone: "+14158675301",
      phoneMasked: "+14****301",
      email: "first@example.test",
    }),
    registerInvitedClient(pool, {
      ...base,
      phone: "+14158675302",
      phoneMasked: "+14****302",
      email: "second@example.test",
    }),
  ]);
  assert.equal(
    attempts.filter(({ status }) => status === "fulfilled").length,
    1,
    attempts.map((attempt) => attempt.status === "rejected" ? `${attempt.reason?.code}:${attempt.reason?.message}` : "fulfilled").join(" | "),
  );
  assert.equal(attempts.filter(({ status }) => status === "rejected").length, 1);
  const rejection = attempts.find(({ status }) => status === "rejected").reason;
  assert.equal(rejection.code, "INVITATION_INVALID");

  const winner = attempts.find(({ status }) => status === "fulfilled").value;
  const invitation = (await pool.query(
    `SELECT status,used_by_user_id FROM invitations WHERE id='single-invite'`,
  )).rows[0];
  assert.deepEqual(invitation, { status: "used", used_by_user_id: winner.userId });
  const committedRegistrations = (await pool.query(`
    SELECT count(*)::int AS count FROM users
    WHERE email IN ('first@example.test','second@example.test')
  `)).rows[0].count;
  assert.equal(committedRegistrations, 1);
  const pendingMembership = (await pool.query(
    `SELECT status,starts_at,expires_at,max_active_strategies FROM memberships WHERE id=$1`,
    [winner.membershipId],
  )).rows[0];
  assert.deepEqual(pendingMembership, {
    status: "pending", starts_at: null, expires_at: null, max_active_strategies: 3,
  });
  assert.equal(Number((await pool.query(
    `SELECT count(*) AS count FROM official_paper_portfolios WHERE membership_id=$1`,
    [winner.membershipId],
  )).rows[0].count), 0);

  const consent = await acceptCurrentCommercialLegalDocuments(pool, {
    userId: winner.userId,
    acceptedDocumentVersionIds: legalTypes.map((_, index) => `registration-legal-${index}`),
    idempotencyKey: "registration-disclosure-accept",
    trustedIp: "203.0.113.20",
    userAgent: "client-onboarding-test",
  });
  assert.equal(consent.consentComplete, true);
  const activeMembership = (await pool.query(
    `SELECT status,starts_at,expires_at,grace_ends_at,max_active_strategies FROM memberships WHERE id=$1`,
    [winner.membershipId],
  )).rows[0];
  assert.equal(activeMembership.status, "active");
  assert.ok(activeMembership.starts_at);
  assert.ok(activeMembership.expires_at);
  assert.ok(activeMembership.grace_ends_at);
  assert.equal(activeMembership.max_active_strategies, 3);
  const portfolios = (await pool.query(
    `SELECT strategy_code,principal_usdt::text FROM official_paper_portfolios WHERE membership_id=$1 ORDER BY strategy_code`,
    [winner.membershipId],
  )).rows;
  assert.deepEqual(portfolios, [
    { strategy_code: "ai_aggressive", principal_usdt: "10000.000000000000" },
    { strategy_code: "ai_balanced", principal_usdt: "10000.000000000000" },
    { strategy_code: "ai_conservative", principal_usdt: "10000.000000000000" },
  ]);
  assert.equal(Number((await pool.query(
    `SELECT count(*) AS count FROM membership_access_events WHERE membership_id=$1 AND event_type='trial_started'`,
    [winner.membershipId],
  )).rows[0].count), 1);
});

test("0036 resets legacy pre-disclosure trial time and restarts three days from consent", async () => {
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('legacy-pre-disclosure','legacy@example.test','x','customer','active'),
      ('legacy-consented','consented@example.test','x','customer','active');
    INSERT INTO memberships(
      id,customer_id,plan_code,status,starts_at,expires_at,grace_ends_at,max_active_strategies
    ) VALUES
      ('legacy-pre-disclosure-trial','legacy-pre-disclosure','trial_monthly_equivalent','active',
       '2026-08-18T00:00:00.000Z','2026-08-21T00:00:00.000Z','2026-08-22T00:00:00.000Z',1),
      ('legacy-consented-trial','legacy-consented','trial_monthly_equivalent','active',
       '2026-08-18T00:00:00.000Z','2026-08-21T00:00:00.000Z','2026-08-22T00:00:00.000Z',1);
    INSERT INTO membership_access_events(
      id,membership_id,customer_id,event_type,effective_at,state_json,dedupe_key
    ) VALUES
      ('legacy-trial-started','legacy-pre-disclosure-trial','legacy-pre-disclosure','trial_started',
       '2026-08-18T00:00:00.000Z','{"source":"legacy_registration"}'::jsonb,
       'membership:legacy-pre-disclosure-trial:trial_started'),
      ('consented-trial-started','legacy-consented-trial','legacy-consented','trial_started',
       '2026-08-18T00:00:00.000Z','{"source":"legacy_registration"}'::jsonb,
       'membership:legacy-consented-trial:trial_started');
  `);
  for (let index = 0; index < legalTypes.length; index += 1) {
    await pool.query(`
      INSERT INTO commercial_legal_acceptances(id,user_id,document_version_id,accepted_at)
      VALUES($1,'legacy-consented',$2,'2026-08-20T01:00:00.000Z')
    `, [`legacy-consent-${index}`, `registration-legal-${index}`]);
  }

  const migration = await readFile(
    new URL("../postgres/migrations/0036_pre_disclosure_trial_remediation.sql", import.meta.url),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);

  assert.deepEqual((await pool.query(`
    SELECT status,starts_at,expires_at,grace_ends_at,max_active_strategies
    FROM memberships WHERE id='legacy-pre-disclosure-trial'
  `)).rows[0], {
    status: "pending",
    starts_at: null,
    expires_at: null,
    grace_ends_at: null,
    max_active_strategies: 3,
  });
  assert.equal((await pool.query(`
    SELECT status FROM memberships WHERE id='legacy-consented-trial'
  `)).rows[0].status, "active");
  const remediationEvents = (await pool.query(`
    SELECT event_type,dedupe_key,state_json
    FROM membership_access_events
    WHERE membership_id='legacy-pre-disclosure-trial'
    ORDER BY effective_at,id
  `)).rows;
  assert.equal(remediationEvents.length, 2);
  assert.deepEqual(remediationEvents.map(({ event_type }) => event_type), [
    "trial_started",
    "trial_reset_pending_disclosure",
  ]);
  assert.equal(
    remediationEvents[1].dedupe_key,
    "membership:legacy-pre-disclosure-trial:trial_reset_pending_disclosure",
  );
  assert.deepEqual(remediationEvents[1].state_json, {
    reason: "pre_disclosure_trial_started_early",
    previousStatus: "active",
    previousStartsAt: "2026-08-18T00:00:00.000Z",
    previousExpiresAt: "2026-08-21T00:00:00.000Z",
    previousGraceEndsAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM audit_logs
    WHERE action='commercial.trial_reset_pending_disclosure'
      AND subject_id='legacy-pre-disclosure-trial'
  `)).rows[0].count, 1);

  const beforeAccept = Date.now();
  await acceptCurrentCommercialLegalDocuments(pool, {
    userId: "legacy-pre-disclosure",
    acceptedDocumentVersionIds: legalTypes.map((_, index) => `registration-legal-${index}`),
    idempotencyKey: "legacy-pre-disclosure-accept",
    trustedIp: "203.0.113.88",
    userAgent: "upgrade-path-test",
  });
  const afterAccept = Date.now();
  const restarted = (await pool.query(`
    SELECT status,starts_at,expires_at,grace_ends_at
    FROM memberships WHERE id='legacy-pre-disclosure-trial'
  `)).rows[0];
  assert.equal(restarted.status, "active");
  const restartedAt = Date.parse(restarted.starts_at);
  assert.ok(restartedAt >= beforeAccept && restartedAt <= afterAccept);
  assert.equal(Date.parse(restarted.expires_at) - restartedAt, 3 * 86_400_000);
  assert.equal(Date.parse(restarted.grace_ends_at) - restartedAt, 4 * 86_400_000);
  assert.deepEqual((await pool.query(`
    SELECT dedupe_key FROM membership_access_events
    WHERE membership_id='legacy-pre-disclosure-trial' AND event_type='trial_started'
    ORDER BY effective_at,id
  `)).rows.map(({ dedupe_key }) => dedupe_key), [
    "membership:legacy-pre-disclosure-trial:trial_started",
    "membership:legacy-pre-disclosure-trial:trial_started:disclosure",
  ]);
});

test("Client profile route checks normalized phone ownership with a specific conflict", async () => {
  const source = await readFile(new URL("../app/api/account/profile/route.client.ts", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../apps/client/ui/account-security-workspace.tsx", import.meta.url), "utf8");
  assert.match(source, /normalizeProfilePhoneUpdate/);
  assert.match(source, /PHONE_TAKEN/);
  assert.match(source, /eq\(users\.phone, phone\)/);
  assert.match(workspace, /手机号（登录标识）/);
  assert.match(workspace, /手机号不能清除/);
});

test("registration response does not claim the trial was activated before disclosure", async () => {
  const source = await readFile(new URL("../app/api/auth/register/route.client.ts", import.meta.url), "utf8");
  assert.match(source, /等待完成商业披露确认后开通3天试用/);
  assert.doesNotMatch(source, /已开通3天/);
});

test("the Client hardening migration backfills existing Beta entitlements to three concurrent official cards", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0034_client_registration_rate_limit.sql", import.meta.url), "utf8");
  assert.match(migration, /plan_code IN[\s\S]*'trial_monthly_equivalent'[\s\S]*'monthly_v1'[\s\S]*'lifetime_v1'/);
  assert.match(migration, /SET max_active_strategies = 3/);
  assert.match(migration, /max_active_strategies < 3/);
});
