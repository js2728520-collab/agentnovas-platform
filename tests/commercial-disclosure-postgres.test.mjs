import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  decideCommercialDisclosure,
  readCommercialDisclosureControl,
  submitCommercialDisclosure,
} from "../lib/commercial-disclosure-service.ts";
import { requiredLegalDocumentTypes } from "../packages/domain/src/commercial-membership-domain.ts";
import {
  acceptCurrentCommercialLegalDocuments,
  readCommercialLegalConsent,
} from "../lib/commercial-membership-service.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `commercial_disclosure_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

const documentContent = (type) => `# ${type}\n\n本商业披露用于说明 Paper SaaS 的服务范围、客户权利、人工付款流程和模拟风险。平台不托管客户交易资金，也不代表客户执行真实交易。`;
const submission = (suffix = "v1") => ({
  locale: "zh-CN",
  reason: `发布商用披露 ${suffix}`,
  productIdentity: {
    operatorName: "Riverton Capital",
    serviceRegion: "受邀用户线上服务区域",
    supportEmail: "support@quality.invalid",
    primaryDomain: "agentnovas.com",
  },
  documents: Object.fromEntries(requiredLegalDocumentTypes.map((type) => [type, `${documentContent(type)}\n\n版本：${suffix}`])),
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await runPostgresMigrations(pool, { directory: new URL("../postgres/migrations/", import.meta.url), commitSha: "disclosure-test" });
  for (const [id, role] of [["maker", "hq_admin"], ["checker", "hq_admin"], ["customer", "customer"]]) {
    await pool.query(`INSERT INTO users(id,email,password_hash,role,status) VALUES($1,$2,'test-only-hash',$3,'active')`, [id, `${id}@quality.invalid`, role]);
  }
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

test("maker-checker publishes an immutable seven-document bundle accepted independently by customers", async () => {
  const pending = await submitCommercialDisclosure(pool, {
    actorUserId: "maker",
    idempotencyKey: "disclosure-submit-v1",
    requestId: "request-disclosure-v1",
    submission: submission(),
  });
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.documents.length, 7);

  await assert.rejects(
    decideCommercialDisclosure(pool, {
      requestId: pending.id,
      reviewerUserId: "maker",
      decision: "approve",
      note: "不能自己复核",
      idempotencyKey: "disclosure-self-review",
    }),
    /提交人不能复核/,
  );

  const approved = await decideCommercialDisclosure(pool, {
    requestId: pending.id,
    reviewerUserId: "checker",
    decision: "approve",
    note: "七份正文、产品身份和收费边界已逐项复核",
    idempotencyKey: "disclosure-review-v1",
  });
  assert.equal(approved.status, "APPROVED");

  const control = await readCommercialDisclosureControl(pool);
  assert.equal(control.activeBundle.version, "1");
  assert.equal(control.activeBundle.documents.length, 7);
  assert.equal(control.readiness.productIdentityComplete, true);

  const beforeAcceptance = await readCommercialLegalConsent(pool, "customer");
  assert.equal(beforeAcceptance.configurationComplete, true);
  assert.equal(beforeAcceptance.consentComplete, false);
  const accepted = await acceptCurrentCommercialLegalDocuments(pool, {
    userId: "customer",
    acceptedDocumentVersionIds: beforeAcceptance.requiredLegalDocuments.map((document) => document.id),
    idempotencyKey: "accept-disclosure-v1",
  });
  assert.equal(accepted.consentComplete, true);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM commercial_legal_acceptances WHERE user_id='customer'`)).rows[0].count, 7);
});

test("a second approved bundle retires the first and requires fresh customer acceptance", async () => {
  const pending = await submitCommercialDisclosure(pool, {
    actorUserId: "maker",
    idempotencyKey: "disclosure-submit-v2",
    requestId: "request-disclosure-v2",
    submission: submission("v2"),
  });
  await decideCommercialDisclosure(pool, {
    requestId: pending.id,
    reviewerUserId: "checker",
    decision: "approve",
    note: "复核新版正文及产品身份快照",
    idempotencyKey: "disclosure-review-v2",
  });
  const bundles = await pool.query(`SELECT status,count(*)::int AS count FROM commercial_disclosure_bundles GROUP BY status ORDER BY status`);
  assert.deepEqual(bundles.rows, [{ status: "active", count: 1 }, { status: "retired", count: 1 }]);
  const consent = await readCommercialLegalConsent(pool, "customer");
  assert.equal(consent.configurationComplete, true);
  assert.equal(consent.consentComplete, false);
  assert.ok(consent.requiredLegalDocuments.every((document) => document.version === 2));
});
