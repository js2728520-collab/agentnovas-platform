import type {
  CursorPage,
  MembershipOrder,
  PerformanceFeeStatement,
} from "@/packages/contracts/src/commercial-beta";

export type { CursorPage, MembershipOrder, PerformanceFeeStatement };

export type PaymentEvidenceView = {
  id: string;
  membershipOrderId: string | null;
  performanceStatementId: string | null;
  kind: string;
  referenceMasked: string;
  amount: string;
  currency: string;
  occurredAt: string;
  recordedByUserId: string;
  status: "RECORDED" | "REJECTED" | "ACCEPTED";
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  canReview: boolean;
};

export type MembershipOrderDetail = {
  order: MembershipOrder;
  evidence: PaymentEvidenceView[];
  decisions: Array<{
    id: string;
    reviewerUserId: string;
    decision: string;
    paymentEvidenceId: string | null;
    createdAt: string;
  }>;
  actions: {
    canRecordEvidence: boolean;
    canSubmit: boolean;
    canReview: boolean;
  };
};

export type PerformanceStatementDetail = {
  statement: PerformanceFeeStatement;
  evidence: PaymentEvidenceView[];
  decisions: Array<{
    id: string;
    stage: string;
    reviewerUserId: string;
    decision: string;
    paymentEvidenceId: string | null;
    createdAt: string;
  }>;
  actions: {
    canReviewAssessment: boolean;
    canRecordPaymentEvidence: boolean;
    canReviewPayment: boolean;
  };
};

export type PaymentEvidenceInput = {
  evidenceKind: "bank_transfer" | "manual_invoice" | "provider_reference";
  providerLabel: string;
  reference: string;
  amount: string;
  currency: "USD" | "USDT";
  occurredAt: string;
  note: string;
};
