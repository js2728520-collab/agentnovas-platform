import assert from "node:assert/strict";
import test from "node:test";

import {
  commercialPlanDto,
  cursorPage,
  databaseMembershipOrderStatus,
  databasePerformanceStatementStatus,
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
  assert.equal(publicPerformanceStatementStatus("payment_pending"), "INVOICED");
  assert.equal(publicPerformanceStatementStatus("no_fee"), "VOID");
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
      priceCurrency: "USD",
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

test("commercial operations scope is fail closed until the security resolver is merged", async () => {
  assert.equal(commercialCustomerScopePredicate().clause, "FALSE");
  await assert.rejects(
    assertOperationsCustomerScope(
      {},
      "PLATFORM",
      { userId: "ops", organizationId: null },
      "customer",
    ),
    /尚未接入安全策略/,
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
    amount: "28.000000000000000000",
    currency: "USD",
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
    providerLabel: "bank",
    referenceMasked: "****1234",
    amount: "28.000000000000000000",
    currency: "USD",
    occurredAt: "2026-08-20T00:00:00.000Z",
    note: "ok",
    recordedByUserId: "maker",
    status: "RECORDED",
    reviewedByUserId: null,
    reviewedAt: null,
    createdAt: "2026-08-20T00:00:01.000Z",
  });
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
    cumulative_net_pnl: "1",
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
});
