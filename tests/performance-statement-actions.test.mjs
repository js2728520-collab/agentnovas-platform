import assert from "node:assert/strict";
import test from "node:test";

import { performanceStatementActionProjection } from "../lib/performance-statement-actions.ts";

const projection = (viewerUserId) =>
  performanceStatementActionProjection({
    status: "payment_pending",
    viewerUserId,
    generatedByUserId: "generator",
    assessmentReviewerUserId: "assessment-reviewer",
    evidence: [
      { id: "payment-evidence", recordedByUserId: "payment-maker", status: "recorded" },
    ],
  });

test("performance payment actions are hidden from both assessment-stage actors", () => {
  for (const viewer of ["generator", "assessment-reviewer"]) {
    assert.deepEqual(projection(viewer), {
      canRecordPaymentEvidence: false,
      canReviewPayment: false,
      reviewableEvidenceIds: [],
    });
  }
});

test("payment maker may record but cannot review their own evidence", () => {
  assert.deepEqual(projection("payment-maker"), {
    canRecordPaymentEvidence: true,
    canReviewPayment: false,
    reviewableEvidenceIds: [],
  });
});

test("a fourth reviewer can review a separate payment maker's evidence", () => {
  assert.deepEqual(projection("payment-reviewer"), {
    canRecordPaymentEvidence: true,
    canReviewPayment: true,
    reviewableEvidenceIds: ["payment-evidence"],
  });
});

test("missing unique assessment evidence fails the action projection closed", () => {
  assert.equal(
    performanceStatementActionProjection({
      status: "payment_pending",
      viewerUserId: "payment-reviewer",
      generatedByUserId: "generator",
      assessmentReviewerUserId: null,
      evidence: [],
    }).canRecordPaymentEvidence,
    false,
  );
});
