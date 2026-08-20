import { requireAccessPermission } from "@/lib/access-control";
import { commercialCustomerScopePredicate } from "@/lib/commercial-operations-scope";
import {
  paymentEvidenceDto,
  performanceStatementDto,
} from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { performanceStatementActionProjection } from "@/lib/performance-statement-actions";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(
      request,
      "ops.performance_fees.view",
    );
    const { id } = await params;
    const pool = await getPostgresPool();
    const values: unknown[] = [id];
    const scoped = commercialCustomerScopePredicate(
      scope,
      { userId: user.id, organizationId: user.organizationId },
      "scope_statement_detail",
      "s.user_id",
      2,
      organizationIds,
    );
    values.push(...scoped.values);
    const statementResult = await pool.query(
      `SELECT s.id,s.user_id,s.week_start,s.week_end,
              s.strategy_codes_json,s.week_net_pnl::text,
              s.cumulative_net_pnl::text,s.prior_high_water_mark::text,
              s.eligible_profit::text,s.loss_carry::text,
              s.fee_bps,s.fee_amount::text,s.status,
              s.revision,s.replaces_statement_id,s.generated_by_user_id,
              s.created_at,s.created_at AS submitted_at,
              (SELECT max(d.created_at)
               FROM performance_fee_decisions d
               WHERE d.statement_id=s.id
                 AND d.stage='assessment' AND d.decision='approve') AS approved_at,
              r.paid_at
       FROM performance_fee_statements s
       LEFT JOIN performance_fee_receivables r ON r.statement_id=s.id
       WHERE s.id=$1 AND ${scoped.clause}`,
      values,
    );
    const statement = statementResult.rows[0];
    if (!statement) {
      throw new ResearchApiError(
        "STATEMENT_NOT_FOUND",
        "分成结算单不存在",
        404,
      );
    }
    const [evidenceResult, decisionResult] = await Promise.all([
      pool.query(
        `SELECT id,membership_order_id,performance_statement_id,evidence_kind,
                provider_label,reference_masked,reference_fingerprint_version,
                amount::text,currency,occurred_at,note,recorded_by_user_id,
                status,reviewed_by_user_id,reviewed_at,created_at
         FROM commercial_payment_evidence
         WHERE performance_statement_id=$1
         ORDER BY created_at,id`,
        [id],
      ),
      pool.query(
        `SELECT id,stage,reviewer_user_id,decision,payment_evidence_id,created_at
         FROM performance_fee_decisions
         WHERE statement_id=$1
         ORDER BY created_at,id`,
        [id],
      ),
    ]);
    const approvedAssessmentReviewers = decisionResult.rows.filter(
      (row) => row.stage === "assessment" && row.decision === "approve",
    );
    const assessmentReviewer =
      approvedAssessmentReviewers.length === 1
        ? String(approvedAssessmentReviewers[0].reviewer_user_id)
        : null;
    const paymentActions = performanceStatementActionProjection({
      status: statement.status,
      viewerUserId: user.id,
      generatedByUserId: statement.generated_by_user_id,
      assessmentReviewerUserId: assessmentReviewer,
      evidence: evidenceResult.rows.map((row) => ({
        id: String(row.id),
        recordedByUserId: String(row.recorded_by_user_id),
        status: String(row.status),
      })),
    });
    const evidence = evidenceResult.rows.map((row) => ({
      ...paymentEvidenceDto(row),
      canReview: paymentActions.reviewableEvidenceIds.includes(String(row.id)),
    }));
    return Response.json(
      {
        statement: performanceStatementDto(statement),
        evidence,
        decisions: decisionResult.rows.map((row) => ({
          id: String(row.id),
          stage: String(row.stage),
          reviewerUserId: String(row.reviewer_user_id),
          decision: String(row.decision),
          paymentEvidenceId: row.payment_evidence_id
            ? String(row.payment_evidence_id)
            : null,
          createdAt: new Date(row.created_at).toISOString(),
        })),
        actions: {
          canReviewAssessment:
            statement.status === "pending_review" &&
            statement.generated_by_user_id !== user.id,
          canRecordPaymentEvidence: paymentActions.canRecordPaymentEvidence,
          canReviewPayment: paymentActions.canReviewPayment,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
