export type PerformanceEvidenceActor = {
  id: string;
  recordedByUserId: string;
  status: string;
};

export function performanceStatementActionProjection(input: {
  status: string;
  viewerUserId: string;
  generatedByUserId: string;
  assessmentReviewerUserId: string | null;
  evidence: PerformanceEvidenceActor[];
}) {
  const separatePaymentActor =
    input.status === "payment_pending" &&
    Boolean(input.assessmentReviewerUserId) &&
    input.viewerUserId !== input.generatedByUserId &&
    input.viewerUserId !== input.assessmentReviewerUserId;
  const reviewableEvidenceIds = input.evidence
    .filter(
      (evidence) =>
        separatePaymentActor &&
        evidence.status === "recorded" &&
        evidence.recordedByUserId !== input.viewerUserId &&
        evidence.recordedByUserId !== input.generatedByUserId &&
        evidence.recordedByUserId !== input.assessmentReviewerUserId,
    )
    .map((evidence) => evidence.id);
  return {
    canRecordPaymentEvidence: separatePaymentActor,
    canReviewPayment: reviewableEvidenceIds.length > 0,
    reviewableEvidenceIds,
  };
}
