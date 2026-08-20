import assert from "node:assert/strict";
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
  ensurePlatformLedgerAccount,
  postCommercialLedgerTransaction,
} from "../lib/commercial-ledger-service.ts";
import {
  decidePerformanceAssessment,
  decidePerformancePayment,
  generatePerformanceStatement,
  recordPerformancePaymentEvidence,
} from "../lib/performance-fee-service.ts";

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
const officialScope = async () => ({
  strategyIds: ["strategy-0", "strategy-1", "strategy-2"],
  scopeVersion: "official-three-card-v1",
  source: "official_three_card_portfolio",
});

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
  await pool.query(`INSERT INTO organizations(id,type,name) VALUES('org','headquarters','Org');
    INSERT INTO users(id,email,password_hash,role,organization_id,status) VALUES
      ('customer','customer@example.test','x','customer','org','active'),('customer2','customer2@example.test','x','customer','org','active'),
      ('maker','maker@example.test','x','finance','org','active'),('checker','checker@example.test','x','admin','org','active'),('checker2','checker2@example.test','x','admin','org','active');
    INSERT INTO commercial_legal_document_versions(id,document_type,version,content_sha256,status,approved_by_user_id,approved_at,effective_at) VALUES
      ('entity-v1','service_entity',1,repeat('a',64),'active','checker','2026-01-01','2026-01-01'),
      ('jurisdiction-v1','jurisdiction',1,repeat('b',64),'active','checker','2026-01-01','2026-01-01'),
      ('privacy-v1','privacy',1,repeat('c',64),'active','checker','2026-01-01','2026-01-01'),
      ('terms-v1','terms',1,repeat('d',64),'active','checker','2026-01-01','2026-01-01'),
      ('risk-v1','risk_disclosure',1,repeat('e',64),'active','checker','2026-01-01','2026-01-01'),
      ('fee-opinion-v1','simulated_performance_fee_opinion',1,repeat('f',64),'active','checker','2026-01-01','2026-01-01'),
      ('refund-v1','refund_policy',1,repeat('0',64),'active','checker','2026-01-01','2026-01-01');`);
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
  await recordMembershipPaymentEvidence(pool, {
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
  return order;
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
  await recordMembershipPaymentEvidence(pool, {
    orderId: order.id,
    actorUserId: "checker",
    evidenceKind: "bank_transfer",
    reference: "CHECKER-SECRET-1234",
    amount: "28",
    currency: "USD",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: "order-evidence-checker",
  });
  await recordMembershipPaymentEvidence(pool, {
    orderId: order.id,
    actorUserId: "maker",
    evidenceKind: "bank_transfer",
    reference: "MAKER-SECRET-5678",
    amount: "28",
    currency: "USD",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: "order-evidence-maker",
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
    idempotencyKey: "order-approved",
    requestId: "order-approved",
  });
  assert.equal(activated.status, "activated");
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
      idempotencyKey: "quarterly-approve",
      requestId: "quarterly-approve",
    }),
    decideMembershipOrder(pool, {
      orderId: annual.id,
      reviewerUserId: "checker2",
      decision: "approve",
      note: "ok",
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
    idempotencyKey: "lifetime-approve",
    requestId: "lifetime-approve",
  });
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
      idempotencyKey: "finite-approve",
      requestId: "finite-approve",
    }),
    /终身会员不得/,
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
          `SELECT count(*)::int count FROM audit_logs WHERE subject_id=$1 AND action='commercial.membership.rejected'`,
          [order.id],
      )
    ).rows[0].count,
    0,
  );
  await pool.query(
    `DROP TRIGGER fail_membership_reject_outbox ON notification_deliveries; DROP FUNCTION fail_membership_reject_outbox()`,
  );
  assert.equal(
    (
      await decideMembershipOrder(pool, {
        orderId: order.id,
        reviewerUserId: "checker",
        decision: "reject",
        note: "reject",
        idempotencyKey: "reject-atomic-decision",
        requestId: "reject-atomic",
      })
    ).status,
    "rejected",
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
  await assert.rejects(
    generatePerformanceStatement(pool, {
      userId: "customer",
      generatedByUserId: "maker",
      requestId: "unresolved",
      idempotencyKey: "unresolved",
      now: new Date("2026-08-12T00:00:00Z"),
    }),
    /解析器尚未接入/,
  );
  const statement = await generatePerformanceStatement(pool, {
    userId: "customer",
    generatedByUserId: "maker",
    requestId: "statement-1",
    idempotencyKey: "statement-1",
    now: new Date("2026-08-12T00:00:00Z"),
    resolvePortfolioScope: officialScope,
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
  });
  await assert.rejects(
    decidePerformanceAssessment(pool, {
      statementId: statement.id,
      reviewerUserId: "checker",
      decision: "reject",
      note: "collision",
      idempotencyKey: "statement-approved",
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
      resolvePortfolioScope: officialScope,
    }),
    /前序结算单尚未完成/,
  );
  await recordPerformancePaymentEvidence(pool, {
    statementId: statement.id,
    actorUserId: "checker",
    evidenceKind: "bank_transfer",
    reference: "PAYMENT-CHECKER-1234",
    amount: "40",
    currency: "USDT",
    occurredAt: "2026-08-20T00:00:00Z",
    idempotencyKey: "payment-evidence-checker",
  });
  await recordPerformancePaymentEvidence(pool, {
    statementId: statement.id,
    actorUserId: "maker",
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
      actorUserId: "maker",
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
    reviewerUserId: "checker2",
    decision: "reject",
    note: "bad evidence",
    idempotencyKey: "payment-reject",
    requestId: "payment-reject",
  });
  assert.equal(rejectedPayment.status, "payment_pending");
  assert.ok(rejectedPayment.paymentEvidenceId);
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
  await assert.rejects(
    decidePerformancePayment(pool, {
      statementId: statement.id,
      reviewerUserId: "checker",
      decision: "approve",
      note: "cannot reuse",
      idempotencyKey: "payment-reuse-rejected",
      requestId: "payment-reuse-rejected",
    }),
    /缺少金额币种匹配的待审付款凭证/,
  );
  const newEvidence = await recordPerformancePaymentEvidence(pool, {
    statementId: statement.id,
    actorUserId: "maker",
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
      reviewerUserId: "maker",
      decision: "approve",
      note: "self",
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
      reviewerUserId: "checker",
      decision: "approve",
      note: "verified",
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
    reviewerUserId: "checker",
    decision: "approve",
    note: "verified",
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
        actorUserId: "maker",
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
    resolvePortfolioScope: officialScope,
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
  });
  assert.equal(
    (
      await generatePerformanceStatement(pool, {
        userId: "customer",
        generatedByUserId: "maker",
        requestId: "replay",
        idempotencyKey: "statement-loss",
        now: new Date("2026-08-19T00:00:00Z"),
        resolvePortfolioScope: officialScope,
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
    resolvePortfolioScope: officialScope,
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
    resolvePortfolioScope: officialScope,
  });
  assert.equal(following.week_start.toISOString(), "2026-08-17T00:00:00.000Z");
});
