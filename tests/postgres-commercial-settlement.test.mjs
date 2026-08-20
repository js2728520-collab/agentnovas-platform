import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

import {
  mutateAiCredits,
  releaseAiCreditReservation,
  reserveAiCredits,
  settleAiCreditReservation,
} from "../lib/ai-credit-service.ts";
import {
  createMembershipOrder,
  decideMembershipOrder,
  recordMembershipPaymentEvidence,
  submitMembershipOrder,
} from "../lib/commercial-membership-service.ts";
import {
  fingerprintPaymentReference,
  PAYMENT_REFERENCE_FINGERPRINT_VERSION,
  previousCompleteUtcWeek,
} from "../lib/commercial-api-support.ts";
import {
  ensurePlatformLedgerAccount,
  postCommercialLedgerTransaction,
} from "../lib/commercial-ledger-service.ts";
import {
  decidePerformanceAssessment,
  decidePerformancePayment,
  generatePerformanceStatement,
  recordPerformancePaymentEvidence,
} from "../lib/performance-fee-service.ts";
import { membershipAccess } from "../lib/membership-rules.ts";

const databaseUrl =
  process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `commercial_settlement_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  options: `-c search_path=${schema}`,
});
const legalIds = [
  "entity-v1",
  "jurisdiction-v1",
  "privacy-v1",
  "terms-v1",
  "risk-v1",
  "fee-opinion-v1",
  "refund-v1",
];
const officialAggregate = async (
  client,
  { membershipId, customerId, asOf },
) => {
  const period = previousCompleteUtcWeek(asOf);
  const metric = async (index) =>
    (
      await client.query(
        `SELECT
           to_char(COALESCE(sum(realized_net_pnl_usdt)
             FILTER(WHERE closed_at >= $3 AND closed_at < $4),0),
             'FM999999999999999999990.000000000000') AS week_pnl,
           to_char(COALESCE(sum(realized_net_pnl_usdt)
             FILTER(WHERE closed_at < $4),0),
             'FM999999999999999999990.000000000000') AS cumulative_pnl,
           to_char(COALESCE(sum(realized_net_pnl_usdt)
             FILTER(WHERE closed_at < $3),0),
             'FM999999999999999999990.000000000000') AS prior_pnl
         FROM commercial_closed_paper_pnl
         WHERE user_id=$1 AND strategy_id=$2`,
        [customerId, `strategy-${index}`, period.weekStart, period.weekEnd],
      )
    ).rows[0];
  const metrics = [];
  for (const index of [0, 1, 2]) metrics.push(await metric(index));
  const total = (key) => {
    const scaled = metrics.reduce(
      (sum, row) => sum + BigInt(row[key].replace(".", "")),
      0n,
    );
    const sign = scaled < 0n ? "-" : "";
    const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(13, "0");
    return `${sign}${digits.slice(0, -12)}.${digits.slice(-12)}`;
  };
  const strategies = [
    "ai_conservative",
    "ai_balanced",
    "ai_aggressive",
  ].map((strategyCode, index) => ({
    strategyCode,
    portfolioId: `official-paper:${membershipId}:${strategyCode}`,
    realizedGrossPnlUsdt: metrics[index].week_pnl,
    realizedNetPnlUsdt: metrics[index].week_pnl,
    feesUsdt: "0.000000000000",
    cumulativeNetPnl: metrics[index].cumulative_pnl,
    priorNetPnl: metrics[index].prior_pnl,
  }));
  return {
    customerId,
    membershipId,
    scopeKey: `official-three:${membershipId}`,
    scopeVersion: "official-paper-closed-sells-v1",
    period: { start: period.weekStart, end: period.weekEnd },
    periodStart: period.weekStart,
    periodEnd: period.weekEnd,
    weekNetPnl: total("week_pnl"),
    cumulativeNetPnl: total("cumulative_pnl"),
    priorNetPnl: total("prior_pnl"),
    realizedGrossPnlUsdt: total("week_pnl"),
    realizedNetPnlUsdt: total("week_pnl"),
    feesUsdt: "0.000000000000",
    strategies,
  };
};
let cleanFingerprintNMinusOneVerified = false;

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const migrationNames = (
    await readdir(new URL("../postgres/migrations/", import.meta.url))
  )
    .filter((name) => /^00(?:0\d|1\d|20)_.*\.sql$/.test(name))
    .sort();
  for (const name of [
    ...migrationNames,
    "0022_ledger_approval_invariants.sql",
    "0023_commercial_membership_settlement.sql",
  ])
    await pool.query(
      await readFile(
        new URL(`../postgres/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await pool.query(
    await readFile(
      new URL(
        "../postgres/migrations/0023_commercial_membership_settlement.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await pool.query(`
    ALTER TABLE commercial_payment_evidence
      DROP CONSTRAINT commercial_payment_evidence_fingerprint_version_check,
      DROP COLUMN reference_fingerprint_version;
  `);
  const commercialMigration = await readFile(
    new URL(
      "../postgres/migrations/0023_commercial_membership_settlement.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await pool.query(commercialMigration);
  await pool.query(commercialMigration);
  await pool.query(
    await readFile(
      new URL(
        "../postgres/migrations/0024_platform_demo_execution.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  cleanFingerprintNMinusOneVerified = (await pool.query(`
    SELECT c.is_nullable='NO'
      AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='commercial_payment_evidence_fingerprint_version_check'
          AND conrelid='commercial_payment_evidence'::regclass
      ) AS valid
    FROM information_schema.columns c
    WHERE c.table_schema=current_schema()
      AND c.table_name='commercial_payment_evidence'
      AND c.column_name='reference_fingerprint_version'
  `)).rows[0]?.valid === true;
  await pool.query(`INSERT INTO organizations(id,type,name) VALUES('org','headquarters','Org');
    INSERT INTO users(id,email,password_hash,role,organization_id,status) VALUES
      ('customer','customer@example.test','x','customer','org','active'),('customer2','customer2@example.test','x','customer','org','active'),
      ('official-customer','official-customer@example.test','x','customer','org','active'),
      ('portfolio-failure-customer','portfolio-failure@example.test','x','customer','org','active'),
      ('maker','maker@example.test','x','finance','org','active'),('checker','checker@example.test','x','admin','org','active'),('checker2','checker2@example.test','x','admin','org','active'),
      ('payment-maker','payment-maker@example.test','x','finance','org','active'),('payment-checker','payment-checker@example.test','x','admin','org','active'),
      ('payment-reject-checker','payment-reject-checker@example.test','x','admin','org','active');
    INSERT INTO commercial_legal_document_versions(id,document_type,version,content_sha256,status,approved_by_user_id,approved_at,effective_at) VALUES
      ('entity-v1','service_entity',1,repeat('a',64),'active','checker','2026-01-01','2026-01-01'),
      ('jurisdiction-v1','jurisdiction',1,repeat('b',64),'active','checker','2026-01-01','2026-01-01'),
      ('privacy-v1','privacy',1,repeat('c',64),'active','checker','2026-01-01','2026-01-01'),
      ('terms-v1','terms',1,repeat('d',64),'active','checker','2026-01-01','2026-01-01'),
      ('risk-v1','risk_disclosure',1,repeat('e',64),'active','checker','2026-01-01','2026-01-01'),
      ('fee-opinion-v1','simulated_performance_fee_opinion',1,repeat('f',64),'active','checker','2026-01-01','2026-01-01'),
      ('refund-v1','refund_policy',1,repeat('0',64),'active','checker','2026-01-01','2026-01-01');`);
});

test("fresh and empty unversioned N-1 fingerprint schemas migrate and reapply", () => {
  assert.equal(cleanFingerprintNMinusOneVerified, true);
});
test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

async function readyOrder(
  planVersionId,
  key,
  { evidenceActor = "maker", submitter = "maker", userId = "customer" } = {},
) {
  const order = await createMembershipOrder(pool, {
    userId,
    planVersionId,
    acceptedDocumentVersionIds: legalIds,
    idempotencyKey: `${key}-create`,
    requestId: `${key}-create`,
  });
  const amount = planVersionId.includes("monthly")
    ? "28"
    : planVersionId.includes("quarterly")
      ? "58"
      : planVersionId.includes("annual")
        ? "198"
        : "588";
  const evidence = await recordMembershipPaymentEvidence(pool, {
    orderId: order.id,
    actorUserId: evidenceActor,
    evidenceKind: "bank_transfer",
    reference: `${key}-REFERENCE-1234`,
    amount,
    currency: "USD",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: `${key}-evidence`,
  });
  await submitMembershipOrder(pool, {
    orderId: order.id,
    actorUserId: submitter,
    idempotencyKey: `${key}-submit`,
  });
  return { ...order, paymentEvidenceId: evidence.id };
}

test("seven-current-document gate, USD snapshot and bound idempotency activate safely", async () => {
  await assert.rejects(
    createMembershipOrder(pool, {
      userId: "customer",
      planVersionId: "membership_monthly_v1",
      acceptedDocumentVersionIds: legalIds.slice(0, 6),
      idempotencyKey: "legal-bad",
      requestId: "legal-bad",
    }),
    /七项法务/,
  );
  const order = await createMembershipOrder(pool, {
    userId: "customer",
    planVersionId: "membership_monthly_v1",
    acceptedDocumentVersionIds: legalIds,
    idempotencyKey: "order-create-1",
    requestId: "order-create-1",
  });
  assert.equal(order.price_currency, "USD");
  assert.equal(order.price_amount, "28.000000000000000000");
  assert.equal(
    (
      await createMembershipOrder(pool, {
        userId: "customer",
        planVersionId: "membership_monthly_v1",
        acceptedDocumentVersionIds: [...legalIds].reverse(),
        idempotencyKey: "order-create-1",
        requestId: "another-trace",
      })
    ).id,
    order.id,
  );
  await assert.rejects(
    createMembershipOrder(pool, {
      userId: "customer2",
      planVersionId: "membership_monthly_v1",
      acceptedDocumentVersionIds: legalIds,
      idempotencyKey: "order-create-1",
      requestId: "collision",
    }),
    /已绑定其他操作/,
  );
  const sameCorrelation = await createMembershipOrder(pool, {
    userId: "customer2",
    planVersionId: "membership_monthly_v1",
    acceptedDocumentVersionIds: legalIds,
    idempotencyKey: "order-create-correlation",
    requestId: "order-create-1",
  });
  assert.equal(sameCorrelation.user_id, "customer2");
  const olderEvidence = await recordMembershipPaymentEvidence(pool, {
    orderId: order.id,
    actorUserId: "maker",
    evidenceKind: "bank_transfer",
    reference: "MAKER-SECRET-5678",
    amount: "28",
    currency: "USD",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: "order-evidence-maker",
  });
  const selectedEvidence = await recordMembershipPaymentEvidence(pool, {
    orderId: order.id,
    actorUserId: "checker",
    evidenceKind: "bank_transfer",
    reference: "CHECKER-SECRET-1234",
    amount: "28",
    currency: "USD",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: "order-evidence-checker",
  });
  await assert.rejects(
    recordMembershipPaymentEvidence(pool, {
      orderId: order.id,
      actorUserId: "maker",
      evidenceKind: "bank_transfer",
      reference: "MAKER-SECRET-5678",
      amount: "27",
      currency: "USD",
      occurredAt: "2026-08-20T00:00:00Z",
      idempotencyKey: "order-evidence-mutated",
    }),
    (error) =>
      error.status === 409 && error.code === "PAYMENT_REFERENCE_COLLISION",
  );
  await submitMembershipOrder(pool, {
    orderId: order.id,
    actorUserId: "maker",
    idempotencyKey: "order-submit-1",
  });
  await assert.rejects(
    recordMembershipPaymentEvidence(pool, {
      orderId: order.id,
      actorUserId: "maker",
      evidenceKind: "manual_invoice",
      reference: "LATE-EVIDENCE-AFTER-SUBMIT",
      amount: "28",
      currency: "USD",
      occurredAt: "2026-08-20T00:01:00Z",
      idempotencyKey: "order-evidence-after-submit",
    }),
    (error) =>
      error.status === 409 && error.code === "ORDER_STATE_CONFLICT",
  );
  for (const [action, expected] of [
    ["commercial.membership.order_created", 1],
    ["commercial.membership.evidence_recorded", 2],
    ["commercial.membership.submitted", 1],
  ])
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int count FROM audit_logs WHERE subject_id=$1 AND action=$2`,
          [order.id, action],
        )
      ).rows[0].count,
      expected,
      `missing audit ${action}`,
    );
  for (const [template, expected] of [
    ["membership_order_created", 1],
    ["membership_evidence_recorded", 2],
    ["membership_submitted", 1],
  ])
    assert.equal(
      (
        await pool.query(
          `SELECT count(*)::int count FROM notification_deliveries WHERE user_id='customer' AND template_key=$1`,
          [template],
        )
      ).rows[0].count,
      expected,
      `missing outbox ${template}`,
    );
  await assert.rejects(
    decideMembershipOrder(pool, {
      orderId: order.id,
      reviewerUserId: "maker",
      decision: "approve",
      note: "self",
      paymentEvidenceId: olderEvidence.id,
      idempotencyKey: "order-self",
      requestId: "order-self",
    }),
    /提交人与审批人必须不同/,
  );
  await assert.rejects(
    decideMembershipOrder(pool, {
      orderId: order.id,
      reviewerUserId: "checker",
      decision: "approve",
      note: "evidence actor",
      paymentEvidenceId: selectedEvidence.id,
      idempotencyKey: "order-evidence-actor",
      requestId: "order-evidence-actor",
    }),
    /凭证记录人与审批人必须不同/,
  );
  const activated = await decideMembershipOrder(pool, {
    orderId: order.id,
    reviewerUserId: "checker2",
    decision: "approve",
    note: "verified",
    paymentEvidenceId: olderEvidence.id,
    idempotencyKey: "order-approved",
    requestId: "order-approved",
  });
  assert.equal(activated.status, "activated");
  assert.equal(activated.paymentEvidenceId, olderEvidence.id);
  const boundMembershipEvidence = (
    await pool.query(
      `SELECT d.payment_evidence_id,e.status,e.reviewed_by_user_id,lt.metadata_json FROM commercial_membership_order_decisions d JOIN commercial_payment_evidence e ON e.id=d.payment_evidence_id JOIN commercial_membership_orders o ON o.id=d.order_id JOIN ledger_transactions lt ON lt.id=o.ledger_transaction_id WHERE d.order_id=$1 AND d.idempotency_key='order-approved'`,
      [order.id],
    )
  ).rows[0];
  assert.equal(boundMembershipEvidence.payment_evidence_id, olderEvidence.id);
  assert.equal(boundMembershipEvidence.status, "accepted");
  assert.equal(boundMembershipEvidence.reviewed_by_user_id, "checker2");
  assert.equal(
    boundMembershipEvidence.metadata_json.evidenceId,
    olderEvidence.id,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT status FROM commercial_membership_orders WHERE id=$1`,
        [order.id],
      )
    ).rows[0].status,
    "activated",
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM memberships WHERE customer_id='customer' AND status='active'`,
      )
    ).rows[0].count,
    1,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT available_credits::text FROM ai_credit_accounts WHERE user_id='customer'`,
      )
    ).rows[0].available_credits,
    "1000",
  );
  assert.equal(
    (
      await recordMembershipPaymentEvidence(pool, {
        orderId: order.id,
        actorUserId: "maker",
        evidenceKind: "bank_transfer",
        reference: "MAKER-SECRET-5678",
        amount: "28",
        currency: "USD",
        occurredAt: "2026-08-20T00:00:00Z",
        idempotencyKey: "order-evidence-maker",
      })
    ).membership_order_id,
    order.id,
  );
  await assert.rejects(
    decideMembershipOrder(pool, {
      orderId: order.id,
      reviewerUserId: "checker",
      decision: "approve",
      note: "collision",
      paymentEvidenceId: olderEvidence.id,
      idempotencyKey: "order-approved",
      requestId: "collision",
    }),
    /已绑定其他操作/,
  );
});

test("membership create, evidence and submit roll back with their audit outbox", async () => {
  await pool.query(
    `CREATE OR REPLACE FUNCTION fail_membership_create_outbox() RETURNS trigger AS $$ BEGIN IF NEW.template_key='membership_order_created' THEN RAISE EXCEPTION 'forced create outbox failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_membership_create_outbox BEFORE INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION fail_membership_create_outbox();`,
  );
  await assert.rejects(
    createMembershipOrder(pool, {
      userId: "customer2",
      planVersionId: "membership_monthly_v1",
      acceptedDocumentVersionIds: legalIds,
      idempotencyKey: "atomic-create",
      requestId: "atomic-create",
    }),
    /forced create outbox failure/,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM commercial_membership_orders WHERE user_id='customer2' AND idempotency_key='atomic-create'`,
      )
    ).rows[0].count,
    0,
  );
  await pool.query(
    `DROP TRIGGER fail_membership_create_outbox ON notification_deliveries; DROP FUNCTION fail_membership_create_outbox()`,
  );
  const order = await createMembershipOrder(pool, {
    userId: "customer2",
    planVersionId: "membership_monthly_v1",
    acceptedDocumentVersionIds: legalIds,
    idempotencyKey: "atomic-create",
    requestId: "atomic-create",
  });

  await pool.query(
    `CREATE OR REPLACE FUNCTION fail_membership_evidence_outbox() RETURNS trigger AS $$ BEGIN IF NEW.template_key='membership_evidence_recorded' THEN RAISE EXCEPTION 'forced evidence outbox failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_membership_evidence_outbox BEFORE INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION fail_membership_evidence_outbox();`,
  );
  const evidenceInput = {
    orderId: order.id,
    actorUserId: "maker",
    evidenceKind: "bank_transfer",
    reference: "ATOMIC-EVIDENCE-1234",
    amount: "28",
    currency: "USD",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: "atomic-evidence",
  };
  await assert.rejects(
    recordMembershipPaymentEvidence(pool, evidenceInput),
    /forced evidence outbox failure/,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM commercial_payment_evidence WHERE membership_order_id=$1`,
        [order.id],
      )
    ).rows[0].count,
    0,
  );
  await pool.query(
    `DROP TRIGGER fail_membership_evidence_outbox ON notification_deliveries; DROP FUNCTION fail_membership_evidence_outbox()`,
  );
  await recordMembershipPaymentEvidence(pool, evidenceInput);

  await pool.query(
    `CREATE OR REPLACE FUNCTION fail_membership_submit_outbox() RETURNS trigger AS $$ BEGIN IF NEW.template_key='membership_submitted' THEN RAISE EXCEPTION 'forced submit outbox failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_membership_submit_outbox BEFORE INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION fail_membership_submit_outbox();`,
  );
  await assert.rejects(
    submitMembershipOrder(pool, {
      orderId: order.id,
      actorUserId: "maker",
      idempotencyKey: "atomic-submit",
    }),
    /forced submit outbox failure/,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT status FROM commercial_membership_orders WHERE id=$1`,
        [order.id],
      )
    ).rows[0].status,
    "pending_evidence",
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM audit_logs WHERE subject_id=$1 AND action='commercial.membership.submitted'`,
        [order.id],
      )
    ).rows[0].count,
    0,
  );
  await pool.query(
    `DROP TRIGGER fail_membership_submit_outbox ON notification_deliveries; DROP FUNCTION fail_membership_submit_outbox()`,
  );
  assert.equal(
    (
      await submitMembershipOrder(pool, {
        orderId: order.id,
        actorUserId: "maker",
        idempotencyKey: "atomic-submit",
      })
    ).status,
    "pending_review",
  );
});

test("payment evidence references cannot be reused across orders by switching evidence kind or display label", async () => {
  const first = await createMembershipOrder(pool, {
    userId: "customer",
    planVersionId: "membership_monthly_v1",
    acceptedDocumentVersionIds: legalIds,
    idempotencyKey: "global-reference-order-a",
    requestId: "global-reference-order-a",
  });
  const second = await createMembershipOrder(pool, {
    userId: "customer2",
    planVersionId: "membership_monthly_v1",
    acceptedDocumentVersionIds: legalIds,
    idempotencyKey: "global-reference-order-b",
    requestId: "global-reference-order-b",
  });
  await recordMembershipPaymentEvidence(pool, {
    orderId: first.id,
    actorUserId: "maker",
    evidenceKind: "bank_transfer",
    providerLabel: "untrusted-bank-label-a",
    reference: "  cross   business ref ００１  ",
    amount: "28",
    currency: "USD",
    occurredAt: "2026-08-20T02:00:00Z",
    idempotencyKey: "global-reference-evidence-a",
  });
  await assert.rejects(
    recordMembershipPaymentEvidence(pool, {
      orderId: second.id,
      actorUserId: "maker",
      evidenceKind: "manual_invoice",
      providerLabel: "different-untrusted-bank-label",
      reference: "CROSS BUSINESS REF 001",
      amount: "28",
      currency: "USD",
      occurredAt: "2026-08-20T02:00:00Z",
      idempotencyKey: "global-reference-evidence-b",
    }),
    (error) =>
      error.status === 409 && error.code === "PAYMENT_REFERENCE_COLLISION",
  );
});

test("membership decisions bind the reviewer-selected evidence to the same order in service and PostgreSQL", async () => {
  const first = await readyOrder(
    "membership_monthly_v1",
    "selected-evidence-order-a",
  );
  const second = await readyOrder(
    "membership_monthly_v1",
    "selected-evidence-order-b",
    { userId: "customer2" },
  );
  await assert.rejects(
    decideMembershipOrder(pool, {
      orderId: first.id,
      reviewerUserId: "checker",
      decision: "approve",
      note: "wrong subject",
      paymentEvidenceId: second.paymentEvidenceId,
      idempotencyKey: "selected-evidence-service-mismatch",
      requestId: "selected-evidence-service-mismatch",
    }),
    (error) =>
      error.status === 422 && error.code === "PAYMENT_EVIDENCE_MISMATCH",
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO commercial_membership_order_decisions(id,order_id,reviewer_user_id,decision,note,payment_evidence_id,idempotency_key) VALUES('selected-evidence-direct-mismatch',$1,'checker','approve','wrong subject',$2,'selected-evidence-direct-mismatch')`,
      [first.id, second.paymentEvidenceId],
    ),
    /foreign key|violates/i,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO commercial_membership_order_decisions(id,order_id,reviewer_user_id,decision,note,payment_evidence_id,idempotency_key) VALUES('selected-evidence-direct-null',$1,'checker','approve','missing',NULL,'selected-evidence-direct-null')`,
      [first.id],
    ),
    /not-null|null value/i,
  );
});

test("credits settle derives cost from trusted usage and rolls back every partial mutation", async () => {
  const reservationId = (
    await reserveAiCredits(pool, {
      userId: "customer",
      credits: BigInt(100),
      sourceType: "inference",
      sourceId: "call-1",
      idempotencyKey: "reserve-1",
      requestId: "reserve-1",
      expiresAt: "2026-08-21",
    })
  ).reservationId;
  const settled = await settleAiCreditReservation(pool, {
    reservationId,
    idempotencyKey: "settle-1",
    requestId: "settle-1",
    costModelVersion: "token-cost-v1",
    trustedUsage: {
      source: "provider_metering",
      usageId: "usage-1",
      inputTokens: 0,
      outputTokens: 2_000_000,
    },
  });
  assert.equal(settled.settledCredits, "60");
  await assert.rejects(
    settleAiCreditReservation(pool, {
      reservationId,
      idempotencyKey: "settle-1",
      requestId: "changed-usage",
      costModelVersion: "token-cost-v1",
      trustedUsage: {
        source: "provider_metering",
        usageId: "usage-1",
        inputTokens: 0,
        outputTokens: 1_000_000,
      },
    }),
    /上下文不一致/,
  );
  await assert.rejects(
    settleAiCreditReservation(pool, {
      reservationId,
      idempotencyKey: "other-key",
      requestId: "other",
      costModelVersion: "token-cost-v1",
      trustedUsage: {
        source: "provider_metering",
        usageId: "usage-1",
        inputTokens: 0,
        outputTokens: 2_000_000,
      },
    }),
    /上下文不一致/,
  );
  await assert.rejects(
    reserveAiCredits(pool, {
      userId: "customer2",
      credits: BigInt(100),
      sourceType: "inference",
      sourceId: "call-other",
      idempotencyKey: "reserve-1",
      requestId: "collision",
      expiresAt: "2026-08-21",
    }),
    /已绑定其他变更/,
  );
  await pool.query(
    `CREATE OR REPLACE FUNCTION fail_credit_reserve() RETURNS trigger AS $$ BEGIN IF NEW.source_id='forced-reserve-rollback' THEN RAISE EXCEPTION 'forced reserve failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_credit_reserve BEFORE INSERT ON ai_credit_ledger_entries FOR EACH ROW EXECUTE FUNCTION fail_credit_reserve();`,
  );
  await assert.rejects(
    reserveAiCredits(pool, {
      userId: "customer",
      credits: BigInt(10),
      sourceType: "inference",
      sourceId: "forced-reserve-rollback",
      idempotencyKey: "reserve-forced-rollback",
      requestId: "reserve-forced-rollback",
      expiresAt: "2026-08-21",
    }),
    /forced reserve failure/,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM ai_credit_reservations WHERE idempotency_key='reserve-forced-rollback'`,
      )
    ).rows[0].count,
    0,
  );
  await pool.query(
    `DROP TRIGGER fail_credit_reserve ON ai_credit_ledger_entries; DROP FUNCTION fail_credit_reserve()`,
  );
  const rollbackReservation = (
    await reserveAiCredits(pool, {
      userId: "customer",
      credits: BigInt(50),
      sourceType: "inference",
      sourceId: "rollback",
      idempotencyKey: "reserve-rollback",
      requestId: "reserve-rollback",
      expiresAt: "2026-08-21",
      actorUserId: "maker",
    })
  ).reservationId;
  await pool.query(
    `CREATE OR REPLACE FUNCTION fail_credit_settle() RETURNS trigger AS $$ BEGIN IF NEW.status='settled' THEN RAISE EXCEPTION 'forced settle failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_credit_settle BEFORE UPDATE ON ai_credit_reservations FOR EACH ROW EXECUTE FUNCTION fail_credit_settle();`,
  );
  const before = (
    await pool.query(
      `SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'`,
    )
  ).rows[0];
  await assert.rejects(
    settleAiCreditReservation(pool, {
      reservationId: rollbackReservation,
      idempotencyKey: "settle-rollback",
      requestId: "settle-rollback",
      costModelVersion: "token-cost-v1",
      trustedUsage: {
        source: "provider_metering",
        usageId: "usage-rollback",
        inputTokens: 0,
        outputTokens: 1_000_000,
      },
    }),
    /forced settle failure/,
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT available_credits::text,reserved_credits::text FROM ai_credit_accounts WHERE user_id='customer'`,
      )
    ).rows[0],
    before,
  );
  await pool.query(
    `DROP TRIGGER fail_credit_settle ON ai_credit_reservations; DROP FUNCTION fail_credit_settle()`,
  );
  await releaseAiCreditReservation(pool, {
    reservationId: rollbackReservation,
    idempotencyKey: "release-rollback",
    requestId: "release-rollback",
    actorUserId: "maker",
  });
  assert.equal(
    (
      await releaseAiCreditReservation(pool, {
        reservationId: rollbackReservation,
        idempotencyKey: "release-rollback",
        requestId: "release-replay",
        actorUserId: "maker",
      })
    ).created,
    false,
  );
  await assert.rejects(
    releaseAiCreditReservation(pool, {
      reservationId: rollbackReservation,
      idempotencyKey: "release-other",
      requestId: "release-other",
      actorUserId: "maker",
    }),
    /重放上下文不一致/,
  );
  await assert.rejects(
    releaseAiCreditReservation(pool, {
      reservationId: rollbackReservation,
      idempotencyKey: "release-rollback",
      requestId: "release-other-actor",
      actorUserId: "checker",
    }),
    /重放上下文不一致/,
  );
  await assert.rejects(
    (async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await mutateAiCredits(c, {
          userId: "customer",
          type: "reserve",
          availableDelta: BigInt(-100000),
          reservedDelta: BigInt(100000),
          sourceType: "inference",
          sourceId: "too-large",
          idempotencyKey: "too-large",
          requestId: "too-large",
        });
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    })(),
    /AI_CREDIT_INSUFFICIENT/,
  );
});

test("posted ledger rejects every later posting", async () => {
  const client = await pool.connect();
  let transactionId;
  try {
    await client.query("BEGIN");
    const platform = await ensurePlatformLedgerAccount(
      client,
      "platform_deposit_clearing",
      "USDT",
    );
    await client.query(
      `INSERT INTO ledger_accounts(id,owner_user_id,account_type,currency) VALUES('customer-available','customer','user_available','USDT') ON CONFLICT DO NOTHING`,
    );
    transactionId = (
      await postCommercialLedgerTransaction(client, {
        transactionType: "correction",
        sourceType: "test",
        sourceId: "wallet-credit",
        currency: "USDT",
        idempotencyKey: "wallet-credit",
        requestId: "wallet-credit",
        createdByUserId: "checker",
        postings: [
          { accountId: platform, side: "debit", amount: "5" },
          { accountId: "customer-available", side: "credit", amount: "5" },
        ],
        walletMutation: {
          userId: "customer",
          availableDelta: "5",
          frozenDelta: "0",
        },
        audit: {
          action: "test.wallet.credit",
          subjectType: "user",
          subjectId: "customer",
        },
        outbox: {
          userId: "customer",
          category: "wallet",
          templateKey: "wallet_credited",
          payload: { amount: "5" },
          dedupeKey: "wallet-credit",
        },
      })
    ).id;
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await assert.rejects(
    pool.query(
      `INSERT INTO ledger_postings(id,transaction_id,account_id,side,amount,currency) VALUES('late-posting',$1,'customer-available','credit',1,'USDT')`,
      [transactionId],
    ),
    /LEDGER_TRANSACTION_COMMITTED/,
  );
  await assert.rejects(
    pool.query(
      `UPDATE ledger_transactions SET metadata_json='{}' WHERE id=$1`,
      [transactionId],
    ),
    /LEDGER_APPEND_ONLY/,
  );
  const collisionClient = await pool.connect();
  try {
    await collisionClient.query("BEGIN");
    const platform = await ensurePlatformLedgerAccount(
      collisionClient,
      "platform_deposit_clearing",
      "USDT",
    );
    await assert.rejects(
      postCommercialLedgerTransaction(collisionClient, {
        transactionType: "correction",
        sourceType: "test",
        sourceId: "wallet-credit",
        currency: "USDT",
        idempotencyKey: "wallet-credit",
        requestId: "collision",
        createdByUserId: "checker",
        postings: [
          { accountId: platform, side: "debit", amount: "6" },
          { accountId: "customer-available", side: "credit", amount: "6" },
        ],
        walletMutation: {
          userId: "customer",
          availableDelta: "6",
          frozenDelta: "0",
        },
      }),
      /已绑定其他交易/,
    );
    await collisionClient.query("ROLLBACK");
  } finally {
    collisionClient.release();
  }
});

test("different concurrent orders serialize on one membership row and lifetime cannot downgrade", async () => {
  const [quarterly, annual] = await Promise.all([
    readyOrder("membership_quarterly_v1", "quarterly"),
    readyOrder("membership_annual_v1", "annual"),
  ]);
  const results = await Promise.all([
    decideMembershipOrder(pool, {
      orderId: quarterly.id,
      reviewerUserId: "checker",
      decision: "approve",
      note: "ok",
      paymentEvidenceId: quarterly.paymentEvidenceId,
      idempotencyKey: "quarterly-approve",
      requestId: "quarterly-approve",
    }),
    decideMembershipOrder(pool, {
      orderId: annual.id,
      reviewerUserId: "checker2",
      decision: "approve",
      note: "ok",
      paymentEvidenceId: annual.paymentEvidenceId,
      idempotencyKey: "annual-approve",
      requestId: "annual-approve",
    }),
  ]);
  assert.ok(results.every((result) => result.status === "activated"));
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM memberships WHERE customer_id='customer' AND status='active'`,
      )
    ).rows[0].count,
    1,
  );
  const lifetime = await readyOrder("membership_lifetime_v1", "lifetime");
  await decideMembershipOrder(pool, {
    orderId: lifetime.id,
    reviewerUserId: "checker",
    decision: "approve",
    note: "ok",
    paymentEvidenceId: lifetime.paymentEvidenceId,
    idempotencyKey: "lifetime-approve",
    requestId: "lifetime-approve",
  });
  assert.deepEqual(
    (
      await pool.query(
        `SELECT status,expires_at FROM memberships WHERE customer_id='customer'`,
      )
    ).rows[0],
    { status: "active", expires_at: null },
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT strategy_code,principal_usdt::text,cash_usdt::text
         FROM official_paper_portfolios
         WHERE customer_id='customer'
         ORDER BY strategy_code`,
      )
    ).rows,
    [
      {
        strategy_code: "ai_aggressive",
        principal_usdt: "10000.000000000000",
        cash_usdt: "10000.000000000000",
      },
      {
        strategy_code: "ai_balanced",
        principal_usdt: "10000.000000000000",
        cash_usdt: "10000.000000000000",
      },
      {
        strategy_code: "ai_conservative",
        principal_usdt: "10000.000000000000",
        cash_usdt: "10000.000000000000",
      },
    ],
  );
  const finite = await readyOrder(
    "membership_monthly_v1",
    "finite-after-lifetime",
  );
  await assert.rejects(
    decideMembershipOrder(pool, {
      orderId: finite.id,
      reviewerUserId: "checker2",
      decision: "approve",
      note: "no downgrade",
      paymentEvidenceId: finite.paymentEvidenceId,
      idempotencyKey: "finite-approve",
      requestId: "finite-approve",
    }),
    /终身会员不得/,
  );
});

test("membership activation provisions official portfolios and settles their prior complete UTC week", async () => {
  const order = await readyOrder(
    "membership_lifetime_v1",
    "official-three-card",
    { userId: "official-customer" },
  );
  const activation = await decideMembershipOrder(pool, {
    orderId: order.id,
    reviewerUserId: "checker",
    decision: "approve",
    note: "activate official portfolios",
    paymentEvidenceId: order.paymentEvidenceId,
    idempotencyKey: "official-three-card-approve",
    requestId: "official-three-card-approve",
  });
  assert.equal(activation.status, "activated");
  assert.deepEqual(
    membershipAccess("2099-01-01T00:00:00.000Z", {
      status: "active",
      expiresAt: null,
      graceEndsAt: null,
    }),
    { status: "active", newEntriesAllowed: true, closeOnly: false },
  );

  const portfolios = (
    await pool.query(
      `SELECT id,strategy_code FROM official_paper_portfolios
       WHERE membership_id=$1 AND customer_id='official-customer'
       ORDER BY strategy_code`,
      [activation.membershipId],
    )
  ).rows;
  assert.equal(portfolios.length, 3);
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int AS count
         FROM official_paper_ledger_entries
         WHERE portfolio_id=ANY($1::text[]) AND entry_type='initial_cash'`,
        [portfolios.map(({ id }) => id)],
      )
    ).rows[0].count,
    3,
  );
  const replay = await decideMembershipOrder(pool, {
    orderId: order.id,
    reviewerUserId: "checker",
    decision: "approve",
    note: "activate official portfolios",
    paymentEvidenceId: order.paymentEvidenceId,
    idempotencyKey: "official-three-card-approve",
    requestId: "official-three-card-approve",
  });
  assert.equal(replay.membershipId, activation.membershipId);
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int AS count FROM official_paper_portfolios
         WHERE membership_id=$1`,
        [activation.membershipId],
      )
    ).rows[0].count,
    3,
  );

  for (const [index, portfolio] of portfolios.entries()) {
    const deploymentId = `official-settlement-deployment-${index}`;
    const cycleId = `official-settlement-cycle-${index}`;
    await pool.query(
      `INSERT INTO strategy_deployments(
         id,owner_user_id,strategy_id,strategy_version_id,exchange_account_id,
         mode,status,validation_label,idempotency_key,execution_product,
         platform_strategy_code,membership_id,paper_portfolio_id
       ) VALUES($1,'official-customer',$2,$3,NULL,'paper','active','UNVERIFIED',$1,
         'spot_usdt',$4,$5,$6)`,
      [
        deploymentId,
        `official-settlement-strategy-${index}`,
        `official-settlement-version-${index}`,
        portfolio.strategy_code,
        activation.membershipId,
        portfolio.id,
      ],
    );
    await pool.query(
      `INSERT INTO strategy_runtime_cycles(
         id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,
         status,decision_json,trace_id,started_at
       ) VALUES($1,$2,1,1,'2026-09-01','2026-09-02','completed','{}',$1,'2026-09-01')`,
      [cycleId, deploymentId],
    );
    for (const [label, filledAt, gross, fee, entryFee, net] of [
      ["prior", "2026-09-02T12:00:00Z", "11", "0.5", "0.5", "10"],
      ["week", "2026-09-08T12:00:00Z", "101", "0.5", "0.5", "100"],
    ]) {
      const intentId = `official-settlement-${label}-intent-${index}`;
      await pool.query(
        `INSERT INTO official_paper_order_intents(
           id,portfolio_id,deployment_id,runtime_cycle_id,idempotency_key,symbol,
           action,execution_timing,status,payload_json,filled_at
         ) VALUES($1,$2,$3,$4,$1,'BTCUSDT','sell','next_candle_open','filled','{}',$5)`,
        [intentId, portfolio.id, deploymentId, cycleId, filledAt],
      );
      await pool.query(
        `INSERT INTO official_paper_fill_receipts(
           id,intent_id,portfolio_id,symbol,action,quantity,fill_price,notional_usdt,
           fee_usdt,allocated_entry_fee_usdt,realized_pnl_usdt,
           realized_gross_pnl_usdt,realized_net_pnl_usdt,trace_id,filled_at
         ) VALUES($1,$2,$3,'BTCUSDT','sell',1,100,100,$4,$5,$6,$7,$6,$1,$8)`,
        [
          `official-settlement-${label}-receipt-${index}`,
          intentId,
          portfolio.id,
          fee,
          entryFee,
          net,
          gross,
          filledAt,
        ],
      );
    }
  }

  const statement = await generatePerformanceStatement(pool, {
    userId: "official-customer",
    generatedByUserId: "maker",
    requestId: "official-statement",
    idempotencyKey: "official-statement",
    now: new Date("2026-09-14T12:00:00Z"),
  });
  assert.equal(statement.week_net_pnl, "300.000000000000000000");
  assert.equal(statement.cumulative_net_pnl, "330.000000000000000000");
  assert.equal(statement.prior_high_water_mark, "30.000000000000000000");
  assert.equal(statement.fee_amount, "48.000000000000000000");
  assert.equal(statement.strategy_codes_json.strategyIds, undefined);
  assert.equal(
    statement.strategy_codes_json.scopeVersion,
    "official-paper-closed-sells-v1",
  );
  assert.equal(statement.strategy_codes_json.strategies.length, 3);
  assert.deepEqual(statement.strategy_codes_json.period, {
    start: "2026-09-07T00:00:00.000Z",
    end: "2026-09-14T00:00:00.000Z",
  });
  assert.equal(
    (
      await pool.query(
        `SELECT (after_json::jsonb)->'scope'->>'scopeKey' AS scope_key
         FROM audit_logs
         WHERE subject_id=$1 AND action='commercial.performance.generated'`,
        [statement.id],
      )
    ).rows[0].scope_key,
    `official-three:${activation.membershipId}`,
  );
  assert.equal(
    (
      await decidePerformanceAssessment(pool, {
        statementId: statement.id,
        reviewerUserId: "checker2",
        decision: "approve",
        note: "official aggregate recomputed",
        idempotencyKey: "official-statement-assess",
      })
    ).status,
    "payment_pending",
  );
});

test("official portfolio provisioning failure rolls back membership activation", async () => {
  const order = await readyOrder(
    "membership_monthly_v1",
    "official-provision-failure",
    { userId: "portfolio-failure-customer" },
  );
  await pool.query(
    `CREATE FUNCTION reject_test_portfolio_provision() RETURNS trigger AS $$
       BEGIN
         IF NEW.customer_id='portfolio-failure-customer' THEN
           RAISE EXCEPTION 'forced official portfolio provision failure';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql;
     CREATE TRIGGER reject_test_portfolio_provision
       BEFORE INSERT ON official_paper_portfolios
       FOR EACH ROW EXECUTE FUNCTION reject_test_portfolio_provision();`,
  );
  await assert.rejects(
    decideMembershipOrder(pool, {
      orderId: order.id,
      reviewerUserId: "checker",
      decision: "approve",
      note: "must roll back",
      paymentEvidenceId: order.paymentEvidenceId,
      idempotencyKey: "official-provision-failure-approve",
      requestId: "official-provision-failure-approve",
    }),
    /forced official portfolio provision failure/,
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT commercial_order.status AS order_status,
                evidence.status AS evidence_status,
                count(membership.id)::int AS membership_count
         FROM commercial_membership_orders AS commercial_order
         JOIN commercial_payment_evidence AS evidence
           ON evidence.membership_order_id=commercial_order.id
         LEFT JOIN memberships AS membership
           ON membership.customer_id=commercial_order.user_id
         WHERE commercial_order.id=$1
         GROUP BY commercial_order.status,evidence.status`,
        [order.id],
      )
    ).rows[0],
    {
      order_status: "pending_review",
      evidence_status: "recorded",
      membership_count: 0,
    },
  );
  await pool.query(
    `DROP TRIGGER reject_test_portfolio_provision ON official_paper_portfolios;
     DROP FUNCTION reject_test_portfolio_provision();`,
  );
});

test("membership rejection rolls back decision, audit and outbox as one unit", async () => {
  const order = await readyOrder("membership_monthly_v1", "reject-atomic", {
    userId: "customer2",
  });
  await pool.query(
    `CREATE OR REPLACE FUNCTION fail_membership_reject_outbox() RETURNS trigger AS $$ BEGIN IF NEW.template_key='membership_rejected' THEN RAISE EXCEPTION 'forced reject outbox failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_membership_reject_outbox BEFORE INSERT ON notification_deliveries FOR EACH ROW EXECUTE FUNCTION fail_membership_reject_outbox();`,
  );
  await assert.rejects(
    decideMembershipOrder(pool, {
      orderId: order.id,
      reviewerUserId: "checker",
      decision: "reject",
      note: "reject",
      paymentEvidenceId: order.paymentEvidenceId,
      idempotencyKey: "reject-atomic-decision",
      requestId: "reject-atomic",
    }),
    /forced reject outbox failure/,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT status FROM commercial_membership_orders WHERE id=$1`,
        [order.id],
      )
    ).rows[0].status,
    "pending_review",
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM commercial_membership_order_decisions WHERE order_id=$1`,
        [order.id],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT status FROM commercial_payment_evidence WHERE membership_order_id=$1`,
        [order.id],
      )
    ).rows[0].status,
    "recorded",
  );
  assert.equal(
    (
      await pool.query(
          `SELECT count(*)::int count FROM audit_logs WHERE subject_id=$1 AND action='commercial.membership.rejected'`,
          [order.id],
      )
    ).rows[0].count,
    0,
  );
  await pool.query(
    `DROP TRIGGER fail_membership_reject_outbox ON notification_deliveries; DROP FUNCTION fail_membership_reject_outbox()`,
  );
  const rejected = await decideMembershipOrder(pool, {
    orderId: order.id,
    reviewerUserId: "checker",
    decision: "reject",
    note: "reject",
    paymentEvidenceId: order.paymentEvidenceId,
    idempotencyKey: "reject-atomic-decision",
    requestId: "reject-atomic",
  });
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(
    (
      await pool.query(
        `SELECT d.payment_evidence_id,e.status,e.reviewed_by_user_id FROM commercial_membership_order_decisions d JOIN commercial_payment_evidence e ON e.id=d.payment_evidence_id WHERE d.order_id=$1`,
        [order.id],
      )
    ).rows[0],
    {
      payment_evidence_id: rejected.paymentEvidenceId,
      status: "rejected",
      reviewed_by_user_id: "checker",
    },
  );
});

test("only the previous complete UTC week settles server-resolved scope with HWM sequencing", async () => {
  await pool.query(
    `UPDATE membership_entitlement_events SET valid_from='2026-08-01',valid_until=NULL WHERE user_id='customer'`,
  );
  for (const [index, pnl] of ["100", "200", "-50"].entries()) {
    const deployment = `deployment-${index}`,
      cycle = `cycle-${index}`;
    await pool.query(
      `INSERT INTO strategy_deployments(id,owner_user_id,strategy_id,strategy_version_id,exchange_account_id,mode,status,validation_label,idempotency_key) VALUES($1,'customer',$2,$3,$4,'paper','active','STANDARD_VERIFIED',$5)`,
      [
        deployment,
        `strategy-${index}`,
        `version-${index}`,
        `exchange-${index}`,
        deployment,
      ],
    );
    await pool.query(
      `INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,decision_json,trace_id,started_at) VALUES($1,$2,1,1,'2026-08-07','2026-08-08','completed','{}','trace','2026-08-07')`,
      [cycle, deployment],
    );
    await pool.query(
      `INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at) VALUES($1,$2,'long','closed',1,100,101,$3,$3,$4,'2026-08-07','2026-08-08')`,
      [`position-${index}`, deployment, cycle, pnl],
    );
  }
  await pool.query(
    `INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,decision_json,trace_id,started_at) VALUES('historic-cycle','deployment-0',0,1,'2026-07-20','2026-07-21','completed','{}','historic','2026-07-20'); INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at) VALUES('historic-position','deployment-0','long','closed',1,100,101,'historic-cycle','historic-cycle',1000,'2026-07-20','2026-07-21')`,
  );
  const statement = await generatePerformanceStatement(pool, {
    userId: "customer",
    generatedByUserId: "maker",
    requestId: "statement-1",
    idempotencyKey: "statement-1",
    now: new Date("2026-08-12T00:00:00Z"),
    readOfficialAggregate: officialAggregate,
  });
  assert.equal(statement.week_start.toISOString(), "2026-08-03T00:00:00.000Z");
  assert.equal(statement.fee_amount, "40.000000000000000000");
  await pool.query(
    `INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at) VALUES('late-pnl','deployment-0','long','closed',1,100,101,'cycle-0','cycle-0',10,'2026-08-07','2026-08-08')`,
  );
  await assert.rejects(
    decidePerformanceAssessment(pool, {
      statementId: statement.id,
      reviewerUserId: "checker",
      decision: "approve",
      note: "stale",
      idempotencyKey: "statement-stale",
      readOfficialAggregate: officialAggregate,
    }),
    /数据已变化/,
  );
  await pool.query(`DELETE FROM strategy_paper_positions WHERE id='late-pnl'`);
  await decidePerformanceAssessment(pool, {
    statementId: statement.id,
    reviewerUserId: "checker",
    decision: "approve",
    note: "approved",
    idempotencyKey: "statement-approved",
    readOfficialAggregate: officialAggregate,
  });
  await assert.rejects(
    recordPerformancePaymentEvidence(pool, {
      statementId: statement.id,
      actorUserId: "maker",
      evidenceKind: "bank_transfer",
      reference: "PAYMENT-GENERATOR-MUST-NOT-RECORD",
      amount: "40",
      currency: "USDT",
      occurredAt: "2026-08-20T02:00:00Z",
      idempotencyKey: "payment-generator-record-blocked",
    }),
    /付款复核必须由另一组人员执行/,
  );
  for (const [reviewerUserId, idempotencyKeyValue] of [
    ["maker", "payment-generator-review-blocked"],
    ["checker", "payment-assessment-review-blocked"],
  ]) {
    await assert.rejects(
      decidePerformancePayment(pool, {
        statementId: statement.id,
        reviewerUserId,
        decision: "approve",
        note: "must use a separate payment reviewer",
        paymentEvidenceId: "not-reached",
        idempotencyKey: idempotencyKeyValue,
        requestId: idempotencyKeyValue,
      }),
      /付款复核必须由另一组人员执行/,
    );
  }
  await assert.rejects(
    recordPerformancePaymentEvidence(pool, {
      statementId: statement.id,
      actorUserId: "payment-maker",
      evidenceKind: "bank_transfer",
      providerLabel: "performance-provider-label",
      reference: "cross business ref 001",
      amount: "40",
      currency: "USDT",
      occurredAt: "2026-08-20T02:00:00Z",
      idempotencyKey: "cross-membership-performance-evidence",
    }),
    (error) =>
      error.status === 409 && error.code === "PAYMENT_REFERENCE_COLLISION",
  );
  await pool.query(
    `INSERT INTO memberships(id,customer_id,plan_code,status,starts_at,expires_at) VALUES('cross-statement-membership','customer2','membership_monthly_v1','active','2026-08-01','2026-09-01');
     INSERT INTO performance_fee_statements(id,user_id,membership_id,plan_version_id,week_start,week_end,strategy_codes_json,week_net_pnl,cumulative_net_pnl,prior_high_water_mark,eligible_profit,loss_carry,fee_bps,fee_amount,currency,status,generated_by_user_id,request_id) VALUES('cross-statement','customer2','cross-statement-membership','membership_monthly_v1','2026-08-03','2026-08-10','["strategy-0"]',200,200,0,200,0,2000,40,'USDT','payment_pending','maker','cross-statement');
     INSERT INTO performance_fee_decisions(id,statement_id,stage,reviewer_user_id,decision,note,idempotency_key) VALUES('cross-statement-assessment','cross-statement','assessment','checker','approve','fixture assessment','cross-statement-assessment');
     INSERT INTO performance_fee_receivables(id,statement_id,amount,currency,status) VALUES('cross-statement-receivable','cross-statement',40,'USDT','unpaid')`,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO commercial_payment_evidence(id,performance_statement_id,evidence_kind,reference_masked,reference_fingerprint,reference_fingerprint_version,amount,currency,occurred_at,recorded_by_user_id) VALUES('cross-resource-direct','cross-statement','manual_invoice','***001',$1,$2,40,'USDT','2026-08-20T02:00:00Z','maker')`,
      [
        fingerprintPaymentReference("cross business ref 001"),
        PAYMENT_REFERENCE_FINGERPRINT_VERSION,
      ],
    ),
    /unique|duplicate/i,
  );
  await recordPerformancePaymentEvidence(pool, {
    statementId: statement.id,
    actorUserId: "payment-maker",
    evidenceKind: "provider_reference",
    reference: "SHARED-STATEMENT-REFERENCE-7777",
    amount: "40",
    currency: "USDT",
    occurredAt: "2026-08-20T02:30:00Z",
    idempotencyKey: "shared-statement-evidence-a",
  });
  const reverseCurrencyOrder = await createMembershipOrder(pool, {
    userId: "customer2",
    planVersionId: "membership_monthly_v1",
    acceptedDocumentVersionIds: legalIds,
    idempotencyKey: "reverse-currency-order",
    requestId: "reverse-currency-order",
  });
  await assert.rejects(
    recordMembershipPaymentEvidence(pool, {
      orderId: reverseCurrencyOrder.id,
      actorUserId: "maker",
      evidenceKind: "manual_invoice",
      providerLabel: "different-untrusted-provider",
      reference: " shared-statement-reference-７７７７ ",
      amount: "28",
      currency: "USD",
      occurredAt: "2026-08-20T02:30:00Z",
      idempotencyKey: "reverse-currency-evidence",
    }),
    (error) =>
      error.status === 409 && error.code === "PAYMENT_REFERENCE_COLLISION",
  );
  await assert.rejects(
    recordPerformancePaymentEvidence(pool, {
      statementId: "cross-statement",
      actorUserId: "payment-maker",
      evidenceKind: "manual_invoice",
      reference: "shared-statement-reference-7777",
      amount: "40",
      currency: "USDT",
      occurredAt: "2026-08-20T02:30:00Z",
      idempotencyKey: "shared-statement-evidence-b",
    }),
    (error) =>
      error.status === 409 && error.code === "PAYMENT_REFERENCE_COLLISION",
  );
  const otherStatementEvidence = await recordPerformancePaymentEvidence(pool, {
    statementId: "cross-statement",
    actorUserId: "payment-maker",
    evidenceKind: "manual_invoice",
    reference: "CROSS-STATEMENT-ONLY-REFERENCE-8888",
    amount: "40",
    currency: "USDT",
    occurredAt: "2026-08-20T02:31:00Z",
    idempotencyKey: "cross-statement-only-evidence",
  });
  await assert.rejects(
    decidePerformancePayment(pool, {
      statementId: statement.id,
      reviewerUserId: "checker2",
      decision: "approve",
      note: "wrong statement evidence",
      paymentEvidenceId: otherStatementEvidence.id,
      idempotencyKey: "cross-statement-service-decision",
      requestId: "cross-statement-service-decision",
    }),
    (error) =>
      error.status === 422 && error.code === "PAYMENT_EVIDENCE_REQUIRED",
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO performance_fee_decisions(id,statement_id,stage,reviewer_user_id,decision,note,payment_evidence_id,idempotency_key) VALUES('cross-statement-direct-decision',$1,'payment','checker2','approve','wrong statement',$2,'cross-statement-direct-decision')`,
      [statement.id, otherStatementEvidence.id],
    ),
    /foreign key|violates/i,
  );
  await assert.rejects(
    decidePerformanceAssessment(pool, {
      statementId: statement.id,
      reviewerUserId: "checker",
      decision: "reject",
      note: "collision",
      idempotencyKey: "statement-approved",
      readOfficialAggregate: officialAggregate,
    }),
    /已绑定其他操作/,
  );
  await assert.rejects(
    generatePerformanceStatement(pool, {
      userId: "customer",
      generatedByUserId: "maker",
      requestId: "blocked",
      idempotencyKey: "statement-blocked",
      now: new Date("2026-08-19T00:00:00Z"),
      readOfficialAggregate: officialAggregate,
    }),
    /前序结算单尚未完成/,
  );
  await assert.rejects(
    recordPerformancePaymentEvidence(pool, {
      statementId: statement.id,
      actorUserId: "checker",
      evidenceKind: "bank_transfer",
      reference: "PAYMENT-ASSESSMENT-CHECKER-1234",
      amount: "40",
      currency: "USDT",
      occurredAt: "2026-08-20T00:00:00Z",
      idempotencyKey: "payment-evidence-assessment-checker",
    }),
    /付款复核必须由另一组人员执行/,
  );
  const checkerEvidence = await recordPerformancePaymentEvidence(pool, {
    statementId: statement.id,
    actorUserId: "payment-maker",
    evidenceKind: "bank_transfer",
    reference: "PAYMENT-CHECKER-1234",
    amount: "40",
    currency: "USDT",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: "payment-evidence-checker",
  });
  const makerEvidence = await recordPerformancePaymentEvidence(pool, {
    statementId: statement.id,
    actorUserId: "payment-maker",
    evidenceKind: "bank_transfer",
    reference: "PAYMENT-MAKER-5678",
    amount: "40",
    currency: "USDT",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: "payment-evidence-maker",
  });
  await assert.rejects(
    recordPerformancePaymentEvidence(pool, {
      statementId: statement.id,
      actorUserId: "payment-maker",
      evidenceKind: "bank_transfer",
      reference: "PAYMENT-MAKER-5678",
      amount: "39",
      currency: "USDT",
      occurredAt: "2026-08-20T00:00:00Z",
      idempotencyKey: "payment-evidence-mutated",
    }),
    (error) =>
      error.status === 409 && error.code === "PAYMENT_REFERENCE_COLLISION",
  );
  const rejectedPayment = await decidePerformancePayment(pool, {
    statementId: statement.id,
    reviewerUserId: "payment-reject-checker",
    decision: "reject",
    note: "bad evidence",
    paymentEvidenceId: checkerEvidence.id,
    idempotencyKey: "payment-reject",
    requestId: "payment-reject",
  });
  assert.equal(rejectedPayment.status, "payment_pending");
  assert.equal(rejectedPayment.paymentEvidenceId, checkerEvidence.id);
  assert.equal(
    (
      await pool.query(
        `SELECT status FROM commercial_payment_evidence WHERE id=$1`,
        [rejectedPayment.paymentEvidenceId],
      )
    ).rows[0].status,
    "rejected",
  );
  assert.equal(
    (
      await pool.query(
        `SELECT payment_evidence_id FROM performance_fee_decisions WHERE statement_id=$1 AND idempotency_key='payment-reject'`,
        [statement.id],
      )
    ).rows[0].payment_evidence_id,
    rejectedPayment.paymentEvidenceId,
  );
  const remainingRecordedEvidence = (
    await pool.query(
      `SELECT id,status FROM commercial_payment_evidence WHERE performance_statement_id=$1 AND status='recorded' ORDER BY created_at,id`,
      [statement.id],
    )
  ).rows;
  assert.ok(remainingRecordedEvidence.length >= 1);
  assert.ok(
    remainingRecordedEvidence.every(
      (evidence) => evidence.id !== rejectedPayment.paymentEvidenceId,
    ),
  );
  assert.ok(
    remainingRecordedEvidence.some(
      (evidence) => evidence.id === makerEvidence.id,
    ),
  );
  await assert.rejects(
    decidePerformancePayment(pool, {
      statementId: statement.id,
      reviewerUserId: "payment-checker",
      decision: "approve",
      note: "cannot reuse",
      paymentEvidenceId: checkerEvidence.id,
      idempotencyKey: "payment-reuse-rejected",
      requestId: "payment-reuse-rejected",
    }),
    /缺少金额币种匹配的待审付款凭证/,
  );
  const newEvidence = await recordPerformancePaymentEvidence(pool, {
    statementId: statement.id,
    actorUserId: "payment-maker",
    evidenceKind: "bank_transfer",
    reference: "PAYMENT-REPLACEMENT-9012",
    amount: "40",
    currency: "USDT",
    occurredAt: "2026-08-20T01:00:00Z",
    idempotencyKey: "payment-evidence-replacement",
  });
  await assert.rejects(
    decidePerformancePayment(pool, {
      statementId: statement.id,
      reviewerUserId: "payment-maker",
      decision: "approve",
      note: "self",
      paymentEvidenceId: newEvidence.id,
      idempotencyKey: "payment-self",
      requestId: "payment-self",
    }),
    /凭证记录人与审批人必须不同/,
  );
  await pool.query(
    `CREATE OR REPLACE FUNCTION fail_hwm_commit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced hwm failure'; END $$ LANGUAGE plpgsql; CREATE TRIGGER fail_hwm_commit BEFORE UPDATE ON performance_fee_high_water_marks FOR EACH ROW EXECUTE FUNCTION fail_hwm_commit();`,
  );
  await assert.rejects(
    decidePerformancePayment(pool, {
      statementId: statement.id,
      reviewerUserId: "payment-checker",
      decision: "approve",
      note: "verified",
      paymentEvidenceId: newEvidence.id,
      idempotencyKey: "payment-approved",
      requestId: "payment-approved",
    }),
    /forced hwm failure/,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT status,ledger_transaction_id FROM performance_fee_statements WHERE id=$1`,
        [statement.id],
      )
    ).rows[0].status,
    "payment_pending",
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM ledger_transactions WHERE source_type='performance_fee_statement' AND source_id=$1`,
        [statement.id],
      )
    ).rows[0].count,
    0,
  );
  await pool.query(
    `DROP TRIGGER fail_hwm_commit ON performance_fee_high_water_marks; DROP FUNCTION fail_hwm_commit()`,
  );
  const paid = await decidePerformancePayment(pool, {
    statementId: statement.id,
    reviewerUserId: "payment-checker",
    decision: "approve",
    note: "verified",
    paymentEvidenceId: newEvidence.id,
    idempotencyKey: "payment-approved",
    requestId: "payment-approved",
  });
  assert.equal(paid.status, "paid");
  assert.equal(paid.paymentEvidenceId, newEvidence.id);
  const paidLedger = (
    await pool.query(
      `SELECT lt.id,lt.transaction_type FROM performance_fee_statements s JOIN ledger_transactions lt ON lt.id=s.ledger_transaction_id WHERE s.id=$1`,
      [statement.id],
    )
  ).rows[0];
  assert.equal(paidLedger.transaction_type, "performance_fee_payment");
  assert.equal(
    (
      await recordPerformancePaymentEvidence(pool, {
        statementId: statement.id,
        actorUserId: "payment-maker",
        evidenceKind: "bank_transfer",
        reference: "PAYMENT-MAKER-5678",
        amount: "40",
        currency: "USDT",
        occurredAt: "2026-08-20T00:00:00Z",
        idempotencyKey: "payment-evidence-maker",
      })
    ).amount,
    "40.000000000000000000",
  );
  for (const action of [
    "commercial.performance.generated",
    "commercial.performance.assessment.approve",
    "commercial.performance.payment_evidence",
    "commercial.performance.paid",
  ])
    assert.ok(
      (
        await pool.query(
          `SELECT count(*)::int count FROM audit_logs WHERE subject_id=$1 AND action=$2`,
          [statement.id, action],
        )
      ).rows[0].count >= 1,
      `missing audit ${action}`,
    );
  for (const index of [0, 1, 2]) {
    const cycle = `loss-cycle-${index}`;
    await pool.query(
      `INSERT INTO strategy_runtime_cycles(id,deployment_id,sequence,fencing_token,candle_open_time,candle_close_time,status,decision_json,trace_id,started_at) VALUES($1,$2,2,1,'2026-08-14','2026-08-15','completed','{}','loss','2026-08-14')`,
      [cycle, `deployment-${index}`],
    );
    await pool.query(
      `INSERT INTO strategy_paper_positions(id,deployment_id,side,status,quantity,entry_price,exit_price,opened_cycle_id,closed_cycle_id,realized_net_pnl_usdt,opened_at,closed_at) VALUES($1,$2,'long','closed',1,100,90,$3,$3,-100,'2026-08-14','2026-08-15')`,
      [`loss-position-${index}`, `deployment-${index}`, cycle],
    );
  }
  const loss = await generatePerformanceStatement(pool, {
    userId: "customer",
    generatedByUserId: "maker",
    requestId: "statement-loss",
    idempotencyKey: "statement-loss",
    now: new Date("2026-08-19T00:00:00Z"),
    readOfficialAggregate: officialAggregate,
  });
  assert.equal(loss.fee_amount, "0.000000000000000000");
  assert.equal(loss.loss_carry, "300.000000000000000000");
  assert.equal(loss.revision, 1);
  await decidePerformanceAssessment(pool, {
    statementId: loss.id,
    reviewerUserId: "checker",
    decision: "reject",
    note: "regenerate",
    idempotencyKey: "loss-reject",
    readOfficialAggregate: officialAggregate,
  });
  assert.equal(
    (
      await generatePerformanceStatement(pool, {
        userId: "customer",
        generatedByUserId: "maker",
        requestId: "replay",
        idempotencyKey: "statement-loss",
        now: new Date("2026-08-19T00:00:00Z"),
        readOfficialAggregate: officialAggregate,
      })
    ).id,
    loss.id,
  );
  const replacement = await generatePerformanceStatement(pool, {
    userId: "customer",
    generatedByUserId: "maker",
    requestId: "replacement-trace",
    idempotencyKey: "statement-loss-replacement",
    now: new Date("2026-08-19T00:00:00Z"),
    readOfficialAggregate: officialAggregate,
  });
  assert.equal(replacement.revision, 2);
  assert.equal(replacement.replaces_statement_id, loss.id);
  assert.equal(
    (
      await decidePerformanceAssessment(pool, {
        statementId: replacement.id,
        reviewerUserId: "checker2",
        decision: "approve",
        note: "replacement verified",
        idempotencyKey: "loss-replacement-approved",
        readOfficialAggregate: officialAggregate,
      })
    ).status,
    "no_fee",
  );
  const following = await generatePerformanceStatement(pool, {
    userId: "customer",
    generatedByUserId: "maker",
    requestId: "statement-following",
    idempotencyKey: "statement-following",
    now: new Date("2026-08-26T00:00:00Z"),
    readOfficialAggregate: officialAggregate,
  });
  assert.equal(following.week_start.toISOString(), "2026-08-17T00:00:00.000Z");
});

test("commercial evidence writes stop while any fingerprint version needs reconciliation", async () => {
  const unresolvedEvidenceId = (
    await pool.query(
      `SELECT id FROM commercial_payment_evidence ORDER BY created_at,id LIMIT 1`,
    )
  ).rows[0].id;
  await pool.query(`
    ALTER TABLE commercial_payment_evidence
      DROP CONSTRAINT commercial_payment_evidence_fingerprint_version_check;
  `);
  await pool.query(
    `UPDATE commercial_payment_evidence
      SET reference_fingerprint_version='legacy-trim-v1'
      WHERE id=$1`,
    [unresolvedEvidenceId],
  );
  const order = await createMembershipOrder(pool, {
    userId: "customer2",
    planVersionId: "membership_monthly_v1",
    acceptedDocumentVersionIds: legalIds,
    idempotencyKey: "unreconciled-version-order",
    requestId: "unreconciled-version-order",
  });
  for (const write of [
    () => recordMembershipPaymentEvidence(pool, {
      orderId: order.id,
      actorUserId: "maker",
      evidenceKind: "bank_transfer",
      reference: "UNRECONCILED-MEMBERSHIP-9005",
      amount: "28",
      currency: "USD",
      occurredAt: "2026-08-20T00:00:00Z",
      idempotencyKey: "unreconciled-membership-evidence",
    }),
    () => recordPerformancePaymentEvidence(pool, {
      statementId: "cross-statement",
      actorUserId: "payment-maker",
      evidenceKind: "bank_transfer",
      reference: "UNRECONCILED-PERFORMANCE-9005",
      amount: "40",
      currency: "USDT",
      occurredAt: "2026-08-20T00:00:00Z",
      idempotencyKey: "unreconciled-performance-evidence",
    }),
  ]) {
    await assert.rejects(
      write(),
      (error) =>
        error.status === 503
        && error.code === "COMMERCIAL_PAYMENT_FINGERPRINT_RECONCILIATION_REQUIRED",
    );
  }
  await pool.query(
    `UPDATE commercial_payment_evidence
      SET reference_fingerprint_version=$2
      WHERE id=$1`,
    [unresolvedEvidenceId, PAYMENT_REFERENCE_FINGERPRINT_VERSION],
  );
  const migration = await readFile(
    new URL(
      "../postgres/migrations/0023_commercial_membership_settlement.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
});

test("commercial migration backfills N-1 decisions and reapplies subject constraints idempotently", async () => {
  await pool.query(`
    INSERT INTO commercial_membership_orders(
      id,order_no,user_id,plan_version_id,price_amount,price_currency,duration_days,
      ai_credit_grant,performance_fee_bps,legal_snapshot_json,status,idempotency_key,
      request_id,submitted_by_user_id,submitted_at
    ) VALUES(
      'legacy-order','LEGACY-ORDER','customer2','membership_monthly_v1',28,'USD',30,
      1000,2000,'{}','pending_review','legacy-order','legacy-order','maker',now()
    );
    INSERT INTO memberships(id,customer_id,plan_code,status,starts_at,expires_at)
    VALUES('legacy-performance-membership','customer2','membership_monthly_v1','active','2025-01-01','2025-02-01');
    INSERT INTO performance_fee_statements(
      id,user_id,membership_id,plan_version_id,week_start,week_end,strategy_codes_json,
      week_net_pnl,cumulative_net_pnl,prior_high_water_mark,eligible_profit,loss_carry,
      fee_bps,fee_amount,currency,status,generated_by_user_id,request_id
    ) VALUES(
      'legacy-statement','customer2','legacy-performance-membership','membership_monthly_v1',
      '2025-01-06','2025-01-13','["strategy-0"]',200,200,0,200,0,2000,40,
      'USDT','payment_pending','maker','legacy-statement'
    );
    INSERT INTO performance_fee_receivables(id,statement_id,amount,currency,status)
    VALUES('legacy-receivable','legacy-statement',40,'USDT','unpaid');
  `);
  await pool.query(
    `INSERT INTO commercial_payment_evidence(
      id,membership_order_id,evidence_kind,reference_masked,reference_fingerprint,
      reference_fingerprint_version,
      amount,currency,occurred_at,recorded_by_user_id
    ) VALUES(
      'legacy-order-evidence','legacy-order','bank_transfer','***9001',
      $1,$2,28,'USD','2026-08-20T00:00:00Z','maker'
    )`,
    [
      fingerprintPaymentReference("LEGACY-ORDER-REFERENCE-9001"),
      PAYMENT_REFERENCE_FINGERPRINT_VERSION,
    ],
  );
  await pool.query(
    `INSERT INTO commercial_payment_evidence(
      id,performance_statement_id,evidence_kind,reference_masked,reference_fingerprint,
      reference_fingerprint_version,
      amount,currency,occurred_at,recorded_by_user_id
    ) VALUES(
      'legacy-statement-evidence','legacy-statement','manual_invoice','***9002',
      $1,$2,40,'USDT','2026-08-20T00:00:00Z','maker'
    )`,
    [
      fingerprintPaymentReference("LEGACY-STATEMENT-REFERENCE-9002"),
      PAYMENT_REFERENCE_FINGERPRINT_VERSION,
    ],
  );
  await pool.query(`
    DROP INDEX idx_commercial_evidence_reference_fingerprint;
    CREATE UNIQUE INDEX idx_commercial_evidence_currency_reference
      ON commercial_payment_evidence(currency,reference_fingerprint);
    ALTER TABLE commercial_membership_order_decisions
      DROP CONSTRAINT fk_membership_decision_evidence_subject,
      ALTER COLUMN payment_evidence_id DROP NOT NULL;
    ALTER TABLE performance_fee_decisions
      DROP CONSTRAINT performance_fee_decisions_evidence_stage_check,
      DROP CONSTRAINT fk_performance_decision_evidence_subject;
    INSERT INTO commercial_membership_order_decisions(
      id,order_id,reviewer_user_id,decision,note,payment_evidence_id,idempotency_key
    ) VALUES('legacy-order-decision','legacy-order','checker','approve','legacy',NULL,'legacy-order-decision');
    INSERT INTO performance_fee_decisions(
      id,statement_id,stage,reviewer_user_id,decision,note,payment_evidence_id,idempotency_key
    ) VALUES('legacy-payment-decision','legacy-statement','payment','checker','approve','legacy',NULL,'legacy-payment-decision');
  `);
  const migration = await readFile(
    new URL(
      "../postgres/migrations/0023_commercial_membership_settlement.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  assert.equal(
    (
      await pool.query(
        `SELECT payment_evidence_id FROM commercial_membership_order_decisions WHERE id='legacy-order-decision'`,
      )
    ).rows[0].payment_evidence_id,
    "legacy-order-evidence",
  );
  assert.equal(
    (
      await pool.query(
        `SELECT payment_evidence_id FROM performance_fee_decisions WHERE id='legacy-payment-decision'`,
      )
    ).rows[0].payment_evidence_id,
    "legacy-statement-evidence",
  );
  assert.equal(
    (
      await pool.query(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='commercial_membership_order_decisions' AND column_name='payment_evidence_id'`,
      )
    ).rows[0].is_nullable,
    "NO",
  );
  const constraints = new Set(
    (
      await pool.query(
        `SELECT conname FROM pg_constraint WHERE conname IN ('fk_membership_decision_evidence_subject','performance_fee_decisions_evidence_stage_check','fk_performance_decision_evidence_subject')`,
      )
    ).rows.map((row) => row.conname),
  );
  assert.deepEqual(
    constraints,
    new Set([
      "fk_membership_decision_evidence_subject",
      "performance_fee_decisions_evidence_stage_check",
      "fk_performance_decision_evidence_subject",
    ]),
  );
});

test("commercial migration fails closed when N-1 contains a cross-currency duplicate reference", async () => {
  await pool.query(`
    DROP INDEX idx_commercial_evidence_reference_fingerprint;
    CREATE UNIQUE INDEX idx_commercial_evidence_currency_reference
      ON commercial_payment_evidence(currency,reference_fingerprint);
  `);
  const duplicateFingerprint = fingerprintPaymentReference(
    "N-1-CROSS-CURRENCY-CONFLICT-9003",
  );
  await pool.query(
    `INSERT INTO commercial_payment_evidence(
      id,membership_order_id,evidence_kind,reference_masked,reference_fingerprint,
      reference_fingerprint_version,
      amount,currency,occurred_at,recorded_by_user_id
    ) VALUES(
      'legacy-conflict-usd','legacy-order','bank_transfer','***9003',$1,$2,
      28,'USD','2026-08-20T00:00:00Z','maker'
    )`,
    [duplicateFingerprint, PAYMENT_REFERENCE_FINGERPRINT_VERSION],
  );
  await pool.query(
    `INSERT INTO commercial_payment_evidence(
      id,performance_statement_id,evidence_kind,reference_masked,reference_fingerprint,
      reference_fingerprint_version,
      amount,currency,occurred_at,recorded_by_user_id
    ) VALUES(
      'legacy-conflict-usdt','legacy-statement','manual_invoice','***9003',$1,$2,
      40,'USDT','2026-08-20T00:00:00Z','maker'
    )`,
    [duplicateFingerprint, PAYMENT_REFERENCE_FINGERPRINT_VERSION],
  );
  const migration = await readFile(
    new URL(
      "../postgres/migrations/0023_commercial_membership_settlement.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await assert.rejects(
    pool.query(migration),
    /COMMERCIAL_PAYMENT_REFERENCE_CONFLICT/,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::int count FROM commercial_payment_evidence WHERE reference_fingerprint=$1`,
        [duplicateFingerprint],
      )
    ).rows[0].count,
    2,
  );
  assert.deepEqual(
    (
      await pool.query(`
        SELECT
          to_regclass('idx_commercial_evidence_currency_reference') IS NOT NULL AS old_index_preserved,
          to_regclass('idx_commercial_evidence_reference_fingerprint') IS NOT NULL AS new_index_created
      `)
    ).rows[0],
    { old_index_preserved: true, new_index_created: false },
  );
  await pool.query(
    `DELETE FROM commercial_payment_evidence WHERE id IN ('legacy-conflict-usd','legacy-conflict-usdt')`,
  );
  await pool.query(migration);
  await pool.query(migration);
  assert.deepEqual(
    (
      await pool.query(`
        SELECT
          to_regclass('idx_commercial_evidence_currency_reference') IS NOT NULL AS old_index_present,
          to_regclass('idx_commercial_evidence_reference_fingerprint') IS NOT NULL AS new_index_present
      `)
    ).rows[0],
    { old_index_present: false, new_index_present: true },
  );
});

test("legacy trim-only fingerprints require controlled reconciliation without mutation", async () => {
  const rawReference = "  legacy   trim ref 9004  ";
  const legacyTrimFingerprint = createHash("sha256")
    .update(rawReference.trim(), "utf8")
    .digest("hex");
  assert.notEqual(
    legacyTrimFingerprint,
    fingerprintPaymentReference(rawReference),
  );
  await pool.query(
    `INSERT INTO commercial_payment_evidence(
      id,membership_order_id,evidence_kind,reference_masked,reference_fingerprint,
      reference_fingerprint_version,amount,currency,occurred_at,recorded_by_user_id
    ) VALUES(
      'legacy-trim-fingerprint','legacy-order','bank_transfer','***9004',$1,$2,
      28,'USD','2026-08-20T00:00:00Z','maker'
    )`,
    [legacyTrimFingerprint, PAYMENT_REFERENCE_FINGERPRINT_VERSION],
  );
  await pool.query(`
    ALTER TABLE commercial_payment_evidence
      DROP CONSTRAINT commercial_payment_evidence_fingerprint_version_check,
      DROP COLUMN reference_fingerprint_version;
  `);
  const migration = await readFile(
    new URL(
      "../postgres/migrations/0023_commercial_membership_settlement.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await assert.rejects(
    pool.query(migration),
    /COMMERCIAL_PAYMENT_FINGERPRINT_RECONCILIATION_REQUIRED/,
  );
  assert.deepEqual(
    (
      await pool.query(`
        SELECT
          (SELECT reference_fingerprint FROM commercial_payment_evidence
            WHERE id='legacy-trim-fingerprint') AS fingerprint,
          NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema=current_schema()
              AND table_name='commercial_payment_evidence'
              AND column_name='reference_fingerprint_version'
          ) AS version_column_absent,
          to_regclass('idx_commercial_evidence_reference_fingerprint') IS NOT NULL AS index_preserved
      `)
    ).rows[0],
    {
      fingerprint: legacyTrimFingerprint,
      version_column_absent: true,
      index_preserved: true,
    },
  );
});
