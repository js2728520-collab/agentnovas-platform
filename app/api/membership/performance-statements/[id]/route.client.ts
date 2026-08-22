import { requireAccessPermission } from "@/lib/access-control";
import {
  performanceStatementDto,
  performanceStatementTimeline,
} from "@/lib/commercial-public-contract";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user } = await requireAccessPermission(
      request,
      "client.membership.view",
    );
    const { id } = await params;
    const pool = await getPostgresPool();
    const statementResult = await pool.query(
      `SELECT s.id,s.user_id,s.week_start,s.week_end,
              s.strategy_codes_json,s.week_net_pnl::text,
              s.cumulative_net_pnl::text,s.prior_high_water_mark::text,
              s.eligible_profit::text,s.loss_carry::text,
              s.fee_bps,s.fee_amount::text,s.status,
              s.revision,s.replaces_statement_id,s.created_at,
              s.created_at AS submitted_at,
              (SELECT max(d.created_at)
               FROM performance_fee_decisions d
               WHERE d.statement_id=s.id
                 AND d.stage='assessment' AND d.decision='approve') AS approved_at,
              r.id AS receivable_id,r.created_at AS receivable_created_at,r.paid_at
       FROM performance_fee_statements s
       LEFT JOIN performance_fee_receivables r ON r.statement_id=s.id
       WHERE s.id=$1 AND s.user_id=$2`,
      [id, user.id],
    );
    const statement = statementResult.rows[0];
    if (!statement) {
      throw new ResearchApiError(
        "STATEMENT_NOT_FOUND",
        "绩效账单不存在或当前账户不可见",
        404,
      );
    }
    const [decisionResult, evidenceResult] = await Promise.all([
      pool.query(
        `SELECT id,stage,decision,created_at
         FROM performance_fee_decisions
         WHERE statement_id=$1
         ORDER BY created_at,id`,
        [id],
      ),
      pool.query(
        `SELECT id,status,reviewed_at,created_at
         FROM commercial_payment_evidence
         WHERE performance_statement_id=$1
         ORDER BY created_at,id`,
        [id],
      ),
    ]);
    const receivable = statement.receivable_id
      ? {
          id: statement.receivable_id,
          created_at: statement.receivable_created_at,
          paid_at: statement.paid_at,
        }
      : null;
    return Response.json(
      {
        statement: performanceStatementDto(statement),
        timeline: performanceStatementTimeline({
          statement,
          decisions: decisionResult.rows,
          evidence: evidenceResult.rows,
          receivable,
        }),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
