import assert from "node:assert/strict";
import test from "node:test";

import {
  commercialPlanDto,
  cursorPage,
  databaseMembershipOrderStatus,
  databasePerformanceStatementStatus,
  membershipOrderDto,
  membershipActionDto,
  paymentEvidenceDto,
  performanceActionDto,
  performanceStatementDto,
  publicMembershipOrderStatus,
  publicPerformanceStatementStatus,
} from "../lib/commercial-public-contract.ts";
import {
  assertOperationsCustomerScope,
  commercialCustomerScopePredicate,
} from "../lib/commercial-operations-scope.ts";

test("database workflow states never leak through the public contract", () => {
  assert.equal(
    publicMembershipOrderStatus("pending_evidence"),
    "AWAITING_EVIDENCE",
  );
  assert.equal(publicMembershipOrderStatus("pending_review"), "SUBMITTED");
  assert.equal(publicMembershipOrderStatus("activated"), "ACTIVATED");
  assert.equal(publicPerformanceStatementStatus("pending_review"), "SUBMITTED");
  assert.equal(publicPerformanceStatementStatus("approved"), "APPROVED");
  assert.equal(publicPerformanceStatementStatus("payment_pending"), "INVOICED");
  assert.equal(publicPerformanceStatementStatus("no_fee"), "CLOSED_NO_FEE");
  assert.throws(
    () => publicMembershipOrderStatus("approved"),
    /UNKNOWN_MEMBERSHIP_ORDER_STATUS/,
  );
});

test("plan and cursor DTOs match the commercial beta contract", () => {
  assert.deepEqual(
    commercialPlanDto({
      plan_code: "lifetime_v1",
      version: 1,
      price_amount: "588.000000000000000000",
      duration_days: null,
      ai_credit_grant: "36000",
      performance_fee_bps: 1600,
      status: "active",
    }),
    {
      code: "lifetime_v1",
      name: "终身会员",
      priceUsd: "588.00",
      priceCurrency: "USDT",
      durationDays: null,
      aiCredits: 36000,
      performanceFeeRate: "0.16",
      isLifetime: true,
      version: 1,
      isActive: true,
    },
  );
  assert.deepEqual(cursorPage([{ id: "one" }], 25, "next"), {
    data: [{ id: "one" }],
    page: { nextCursor: "next", hasMore: true, limit: 25 },
  });
});

test("membership orders expose a structured immutable legal snapshot", () => {
  const order = membershipOrderDto({
    id: "order-1",
    order_no: "MEM-1",
    user_id: "customer-1",
    status: "pending_evidence",
    plan_code: "monthly_v1",
    version: 1,
    price_amount: "28",
    duration_days: 30,
    ai_credit_grant: "1000",
    performance_fee_bps: 2000,
    legal_snapshot_json: [
      { id: "legal-1", type: "terms", version: "2026-08-20", contentSha256: "a".repeat(64) },
    ],
    submitted_at: null,
    activated_at: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
  });
  assert.deepEqual(order.legalDocuments, [
    { id: "legal-1", type: "terms", version: "2026-08-20", contentSha256: "a".repeat(64) },
  ]);
  assert.equal("legalDocumentVersion" in order, false);
});

test("public workflow filters map to database states and reject unknown values", () => {
  assert.equal(databaseMembershipOrderStatus("SUBMITTED"), "pending_review");
  assert.equal(
    databasePerformanceStatementStatus("INVOICED"),
    "payment_pending",
  );
  assert.throws(
    () => databaseMembershipOrderStatus("pending_review"),
    (error) =>
      error.code === "UNKNOWN_MEMBERSHIP_ORDER_STATUS" && error.status === 422,
  );
  assert.throws(
    () => databasePerformanceStatementStatus("payment_pending"),
    (error) =>
      error.code === "UNKNOWN_PERFORMANCE_STATEMENT_STATUS" &&
      error.status === 422,
  );
});

test("commercial operations scope requires explicit assignment and active attribution context", async () => {
  const scoped = commercialCustomerScopePredicate(
    "ORGANIZATION_SET",
    { userId: "ops", organizationId: "org-a" },
    "scope_order",
    "o.user_id",
    1,
    ["org-a"],
  );
  assert.match(scoped.clause, /customer_attributions/);
  await assert.rejects(
    assertOperationsCustomerScope(
      { query: async () => ({ rows: [] }) },
      "ORGANIZATION_SET",
      { userId: "ops", organizationId: "org-a" },
      "customer",
      ["org-a"],
    ),
    (error) => error.code === "RESOURCE_NOT_FOUND" && error.status === 404,
  );
});

test("commercial action and evidence DTOs are camelCase allowlists", () => {
  const evidence = paymentEvidenceDto({
    id: "e1",
    membership_order_id: "o1",
    performance_statement_id: null,
    evidence_kind: "bank_transfer",
    provider_label: "bank",
    reference_masked: "****1234",
    reference_fingerprint: "never",
    reference_fingerprint_version: "nfkc-upper-v2",
    amount: "28.000000000000000000",
    currency: "USDT",
    occurred_at: "2026-08-20T00:00:00Z",
    note: "ok",
    recorded_by_user_id: "maker",
    status: "recorded",
    reviewed_by_user_id: null,
    reviewed_at: null,
    created_at: "2026-08-20T00:00:01Z",
    secret: "never",
  });
  assert.deepEqual(evidence, {
    id: "e1",
    membershipOrderId: "o1",
    performanceStatementId: null,
    kind: "bank_transfer",
    referenceMasked: "****1234",
    amount: "28.000000000000000000",
    currency: "USDT",
    occurredAt: "2026-08-20T00:00:00.000Z",
    recordedByUserId: "maker",
    status: "RECORDED",
    reviewedByUserId: null,
    reviewedAt: null,
    createdAt: "2026-08-20T00:00:01.000Z",
  });
  assert.equal("referenceFingerprint" in evidence, false);
  assert.equal("referenceFingerprintVersion" in evidence, false);
  assert.equal("note" in evidence, false);
  assert.equal("providerLabel" in evidence, false);
  assert.deepEqual(
    membershipActionDto({
      status: "activated",
      membershipId: "m1",
      ledgerTransactionId: "l1",
      paymentEvidenceId: "e1",
      replayed: false,
      snake_case: "never",
    }),
    {
      status: "ACTIVATED",
      membershipId: "m1",
      ledgerTransactionId: "l1",
      paymentEvidenceId: "e1",
      replayed: false,
    },
  );
  assert.deepEqual(
    performanceActionDto({
      status: "paid",
      ledgerTransactionId: "l2",
      paymentEvidenceId: "e1",
      replayed: false,
      snake_case: "never",
    }),
    {
      status: "PAID",
      ledgerTransactionId: "l2",
      paymentEvidenceId: "e1",
      replayed: false,
    },
  );
  const statement = performanceStatementDto({
    id: "s1",
    user_id: "u1",
    status: "rejected",
    week_start: "2026-08-03",
    week_end: "2026-08-10",
    strategy_codes_json: {
      weeklyGrossRealizedPnl: "1.2",
      simulatedFees: "0.2",
      strategies: [{
        strategyCode: "ai_conservative",
        weeklyGrossRealizedPnl: "1.2",
        weeklyNetRealizedPnl: "1",
        simulatedFees: "0.2",
      }],
    },
    week_net_pnl: "1",
    cumulative_net_pnl: "1",
    loss_carry: "0",
    prior_high_water_mark: "0",
    eligible_profit: "1",
    fee_bps: 2000,
    fee_amount: "0.2",
    created_at: "2026-08-11",
    revision: 2,
    replaces_statement_id: "s0",
  });
  assert.equal(statement.revision, 2);
  assert.equal(statement.replacesStatementId, "s0");
  assert.equal(statement.weeklyNetRealizedPnl, "1");
  assert.equal(statement.simulatedFees, "0.2");
  assert.equal(statement.strategyBreakdown.length, 1);
  assert.equal(statement.highWaterMarkAfter, "1");
  assert.equal(statement.settledHighWaterMark, "0");
  const paid = performanceStatementDto({
    id: "s1-paid",
    user_id: "u1",
    status: "paid",
    week_start: "2026-08-03",
    week_end: "2026-08-10",
    strategy_codes_json: {},
    week_net_pnl: "1",
    cumulative_net_pnl: "1",
    loss_carry: "0",
    prior_high_water_mark: "0",
    eligible_profit: "1",
    fee_bps: 2000,
    fee_amount: "0.2",
    created_at: "2026-08-11",
    paid_at: "2026-08-20",
  });
  assert.equal(paid.settledHighWaterMark, "1");
  const lossWeek = performanceStatementDto({
    ...{
      id: "s2",
      user_id: "u1",
      status: "no_fee",
      week_start: "2026-08-10",
      week_end: "2026-08-17",
      strategy_codes_json: {},
      week_net_pnl: "-20",
      cumulative_net_pnl: "80",
      prior_high_water_mark: "100",
      eligible_profit: "0",
      loss_carry: "20",
      fee_bps: 2000,
      fee_amount: "0",
      created_at: "2026-08-18",
    },
  });
  assert.equal(lossWeek.highWaterMarkAfter, "100");
});
