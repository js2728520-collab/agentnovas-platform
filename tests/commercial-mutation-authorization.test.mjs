import assert from "node:assert/strict";
import test from "node:test";

import {
  decideMembershipOrder,
  recordMembershipPaymentEvidence,
  submitMembershipOrder,
} from "../lib/commercial-membership-service.ts";
import {
  decidePerformanceAssessment,
  decidePerformancePayment,
  generatePerformanceStatement,
  recordPerformancePaymentEvidence,
} from "../lib/performance-fee-service.ts";

function transactionFixture() {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      if (/FROM commercial_membership_orders WHERE id=\$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ id: "order-1", user_id: "customer-1" }] };
      }
      if (/SELECT id FROM users WHERE id=\$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ id: "customer-1" }] };
      }
      if (/FROM performance_fee_statements WHERE id=\$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ id: "statement-1", user_id: "customer-1" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    client,
    pool: { connect: async () => client },
    queries,
  };
}

test("every commercial Operations mutation authorizes on its business transaction", async () => {
  const now = new Date().toISOString();
  const cases = [
    (pool, authorize) => recordMembershipPaymentEvidence(pool, {
      orderId: "order-1",
      actorUserId: "ops-maker",
      evidenceKind: "bank_transfer",
      reference: "membership-reference",
      amount: "1",
      currency: "USDT",
      occurredAt: now,
      idempotencyKey: "membership-evidence",
      authorize,
    }),
    (pool, authorize) => submitMembershipOrder(pool, {
      orderId: "order-1",
      actorUserId: "ops-maker",
      idempotencyKey: "membership-submit",
      authorize,
    }),
    (pool, authorize) => decideMembershipOrder(pool, {
      orderId: "order-1",
      reviewerUserId: "ops-checker",
      decision: "approve",
      note: "reviewed",
      paymentEvidenceId: "evidence-1",
      idempotencyKey: "membership-decision",
      requestId: "request-membership-decision",
      authorize,
    }),
    (pool, authorize) => generatePerformanceStatement(pool, {
      userId: "customer-1",
      generatedByUserId: "ops-maker",
      requestId: "request-performance-generate",
      idempotencyKey: "performance-generate",
      authorize,
    }),
    (pool, authorize) => decidePerformanceAssessment(pool, {
      statementId: "statement-1",
      reviewerUserId: "ops-checker",
      decision: "approve",
      note: "reviewed",
      idempotencyKey: "performance-assessment",
      authorize,
    }),
    (pool, authorize) => recordPerformancePaymentEvidence(pool, {
      statementId: "statement-1",
      actorUserId: "ops-maker",
      evidenceKind: "bank_transfer",
      reference: "performance-reference",
      amount: "1",
      currency: "USDT",
      occurredAt: now,
      idempotencyKey: "performance-evidence",
      authorize,
    }),
    (pool, authorize) => decidePerformancePayment(pool, {
      statementId: "statement-1",
      reviewerUserId: "ops-checker",
      decision: "approve",
      note: "reviewed",
      paymentEvidenceId: "evidence-2",
      idempotencyKey: "performance-payment",
      requestId: "request-performance-payment",
      authorize,
    }),
  ];

  for (const invoke of cases) {
    const fixture = transactionFixture();
    const denied = new Error("scope changed before mutation");
    let calls = 0;
    const authorize = async (client, customerId) => {
      calls += 1;
      assert.equal(client, fixture.client);
      assert.equal(customerId, "customer-1");
      throw denied;
    };

    await assert.rejects(invoke(fixture.pool, authorize), (error) => error === denied);
    assert.equal(calls, 1);
    assert.ok(fixture.queries.some((sql) => /FOR UPDATE/.test(sql)));
    assert.ok(fixture.queries.some((sql) => sql === "ROLLBACK"));
    assert.doesNotMatch(fixture.queries.join("\n"), /commercial_idempotency/i);
  }
});
