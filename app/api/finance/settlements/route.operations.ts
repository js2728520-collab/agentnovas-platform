import { requireAccessPermission } from "@/lib/access-control";
import { getPostgresPool } from "@/lib/postgres";
import { canAccessOrganization, organizationScopePredicate } from "@/lib/operations-access";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.ledger.view");
    const pool = await getPostgresPool();
    const scoped = organizationScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "beneficiary_id", 1, organizationIds);
    const result = await pool.query(`SELECT id, kind, period_start, period_end, beneficiary_id, amount_usdt, network, status, approval_id, created_at FROM settlements WHERE ${scoped.clause} ORDER BY created_at DESC LIMIT 200`, scoped.values);
    return Response.json({ settlements: result.rows.map((row) => ({ id: row.id, kind: row.kind, periodStart: row.period_start, periodEnd: row.period_end, beneficiaryId: row.beneficiary_id, amountUsdt: row.amount_usdt, network: row.network, status: row.status, approvalId: row.approval_id, createdAt: row.created_at })) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return researchErrorResponse(error, request); }
}

export async function POST(request: Request) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.reconciliation.run");
    const body = await readResearchJson(request);
    const periodStart = String(body.periodStart ?? "");
    const periodEnd = String(body.periodEnd ?? "");
    const beneficiaryId = String(body.beneficiaryId ?? "");
    const network = String(body.network ?? "");
    const amountUsdt = Number(body.amountUsdt);
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (!periodStart || !periodEnd || !beneficiaryId || !["TRC20", "ERC20", "BEP20"].includes(network) || !Number.isFinite(amountUsdt) || amountUsdt <= 0 || !reason) throw new ResearchApiError("VALIDATION_ERROR", "结算期间、收款方、金额、网络和原因均为必填", 422);
    if (!canAccessOrganization(scope, { userId: user.id, organizationId: user.organizationId }, beneficiaryId, organizationIds)) throw new ResearchApiError("FORBIDDEN", "不能为当前数据范围外的组织创建结算", 403);
    const pool = await getPostgresPool();
    const client = await pool.connect();
    const settlementId = crypto.randomUUID();
    const approvalId = crypto.randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO settlements (id, kind, period_start, period_end, beneficiary_id, amount_usdt, network, status, approval_id) VALUES ($1, 'organization_monthly', $2, $3, $4, $5, $6, 'review', $7)`, [settlementId, periodStart, periodEnd, beneficiaryId, amountUsdt, network, approvalId]);
      await client.query(`INSERT INTO approval_requests (id, type, branch_id, subject_type, subject_id, payload_json, requested_by) VALUES ($1, 'settlement_payment', $2, 'settlement', $3, $4, $5)`, [approvalId, user.organizationId, settlementId, JSON.stringify({ periodStart, periodEnd, beneficiaryId, amountUsdt, network, reason }), user.id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    return Response.json({ settlementId, approvalId, status: "review", paymentExecuted: false }, { status: 201 });
  } catch (error) { return researchErrorResponse(error, request); }
}
