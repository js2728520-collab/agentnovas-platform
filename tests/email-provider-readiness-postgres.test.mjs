import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import pg from "pg";

import { recordEmailProviderReadiness } from "../lib/email-provider-readiness.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `email_readiness_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  for (const filename of ["0000_business_schema.sql", "0015_riverton_three_app_rbac_wallet.sql"]) {
    await pool.query(await readFile(new URL(`../postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await pool.query(`
    INSERT INTO organizations (id,type,name,status) VALUES ('hq','headquarters','HQ','active');
    INSERT INTO users (id,email,password_hash,role,organization_id,status)
      VALUES ('admin','admin@example.test','unused','hq_admin','hq','active');
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("email readiness activation is all-or-nothing and writes non-secret audit evidence", async () => {
  await assert.rejects(recordEmailProviderReadiness(pool, {
    action: "activate",
    evidenceReference: "change-2026-08-22",
    senderDomainVerified: true,
    webhookVerified: true,
    templatesVerified: false,
    suppressionEnabled: true,
    inboundMailboxesVerified: false,
  }), /EMAIL_READINESS_INCOMPLETE/);

  const result = await recordEmailProviderReadiness(pool, {
    action: "activate",
    evidenceReference: "change-2026-08-22",
    senderDomainVerified: true,
    webhookVerified: true,
    templatesVerified: true,
    suppressionEnabled: true,
    inboundMailboxesVerified: false,
  });
  assert.deepEqual(result, { ok: true, status: "active", actorUserId: "admin" });
  const provider = (await pool.query(`
    SELECT status,sender_domain,settings_json,encrypted_secret_ref
    FROM notification_provider_configs
    WHERE provider='resend' AND channel='email'
  `)).rows[0];
  assert.equal(provider.status, "active");
  assert.equal(provider.sender_domain, "agentnovas.com");
  assert.equal(provider.encrypted_secret_ref, null);
  assert.deepEqual(provider.settings_json, {
    evidenceReference: "change-2026-08-22",
    inboundMailboxesVerified: false,
    senderDomainVerified: true,
    suppressionEnabled: true,
    templatesVerified: true,
    webhookVerified: true,
  });
  const audit = (await pool.query(`
    SELECT action,after_json FROM audit_logs
    WHERE action='system.email_provider_readiness_recorded'
  `)).rows[0];
  assert.ok(audit);
  assert.doesNotMatch(audit.after_json, /re_[A-Za-z0-9_-]+|whsec_[A-Za-z0-9_-]+/);
});

test("disabling readiness is explicit and keeps historical audit records", async () => {
  const result = await recordEmailProviderReadiness(pool, {
    action: "disable",
    evidenceReference: "incident-2026-08-22",
    senderDomainVerified: true,
    webhookVerified: false,
    templatesVerified: true,
    suppressionEnabled: true,
    inboundMailboxesVerified: false,
  });
  assert.equal(result.status, "disabled");
  assert.equal((await pool.query(`
    SELECT count(*)::int AS count FROM audit_logs
    WHERE action='system.email_provider_readiness_recorded'
  `)).rows[0].count, 2);
});

test("the readiness CLI accepts only explicit non-secret facts", async () => {
  const source = await readFile(new URL("../scripts/record-email-provider-readiness.mjs", import.meta.url), "utf8");
  assert.match(source, /ALLOW_EMAIL_READINESS_UPDATE/);
  assert.match(source, /EMAIL_READINESS_EVIDENCE_REFERENCE/);
  assert.doesNotMatch(source, /RESEND_API_KEY|RESEND_WEBHOOK_SECRET|process\.argv/);
});
