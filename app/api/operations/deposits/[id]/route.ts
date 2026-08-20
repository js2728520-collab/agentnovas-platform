import { requireAccessPermission } from "@/lib/access-control";
import { customerScopePredicate, maskOperationsEmail, maskOperationsValue } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, access, scope, organizationIds } = await requireAccessPermission(request, "ops.deposits.view");
    const canRevealPii = Boolean(access.permissions["ops.deposits.pii_reveal"]);
    const { id } = await context.params;
    const pool = await getPostgresPool();
    const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "d", "d.user_id", 2, organizationIds);
    const result = await pool.query<{
      id: string;
      platform_order_no: string;
      user_id: string;
      branch_id: string | null;
      email: string | null;
      phone: string | null;
      nickname: string;
      currency: string;
      network: string | null;
      expected_amount: string | null;
      actual_amount: string | null;
      usdt_value: string | null;
      fee_amount: string;
      credited_amount: string;
      channel: string;
      provider: string | null;
      provider_order_id: string | null;
      source_address: string | null;
      deposit_address: string | null;
      tx_id: string | null;
      confirmations: number;
      required_confirmations: number | null;
      order_status: string;
      funds_status: string;
      risk_status: string;
      risk_reasons_json: unknown;
      ledger_transaction_id: string | null;
      created_at: Date;
      updated_at: Date;
      external_received_at: Date | null;
      credited_at: Date | null;
      returned_at: Date | null;
    }>(`
      SELECT d.id, d.platform_order_no, d.user_id, d.branch_id, u.email, u.phone, u.nickname,
             d.currency, d.network, d.expected_amount::text, d.actual_amount::text,
             d.usdt_value::text, d.fee_amount::text, d.credited_amount::text,
             d.channel, d.provider, d.provider_order_id, d.source_address, d.deposit_address,
             d.tx_id, d.confirmations, d.required_confirmations, d.order_status,
             d.funds_status, d.risk_status, d.risk_reasons_json, d.ledger_transaction_id,
             d.created_at, d.updated_at, d.external_received_at, d.credited_at, d.returned_at
      FROM deposit_orders AS d
      INNER JOIN users AS u ON u.id = d.user_id
      WHERE d.id = $1 AND ${scoped.clause}
      LIMIT 1
    `, [id, ...scoped.values]);
    const row = result.rows[0];
    if (!row) throw new ResearchApiError("NOT_FOUND", "充值订单不存在", 404);

    const actions = await pool.query<{
      id: string;
      action: string;
      status: string;
      reason: string;
      requested_by_user_id: string;
      requested_at: Date;
      completed_at: Date | null;
      decisions: unknown;
    }>(`
      SELECT ar.id, ar.action, ar.status, ar.reason, ar.requested_by_user_id,
             ar.requested_at, ar.completed_at,
             COALESCE(jsonb_agg(jsonb_build_object(
               'id', ad.id,
               'reviewerUserId', ad.reviewer_user_id,
               'decision', ad.decision,
               'note', ad.note,
               'createdAt', ad.created_at
             ) ORDER BY ad.created_at) FILTER (WHERE ad.id IS NOT NULL), '[]'::jsonb) AS decisions
      FROM deposit_action_requests AS ar
      LEFT JOIN deposit_action_decisions AS ad ON ad.request_id = ar.id
      WHERE ar.deposit_order_id = $1
      GROUP BY ar.id
      ORDER BY ar.requested_at DESC
    `, [id]);

    return Response.json({
      deposit: {
        id: row.id,
        platformOrderNo: row.platform_order_no,
        user: {
          id: row.user_id,
          email: canRevealPii ? row.email : maskOperationsEmail(row.email),
          phone: canRevealPii ? row.phone : maskOperationsValue(row.phone),
          nickname: row.nickname,
        },
        branchId: row.branch_id,
        currency: row.currency,
        network: row.network,
        expectedAmount: row.expected_amount,
        actualAmount: row.actual_amount,
        usdtValue: row.usdt_value,
        feeAmount: row.fee_amount,
        creditedAmount: row.credited_amount,
        channel: row.channel,
        provider: row.provider,
        providerOrderId: row.provider_order_id,
        sourceAddress: canRevealPii ? row.source_address : maskOperationsValue(row.source_address),
        depositAddress: canRevealPii ? row.deposit_address : maskOperationsValue(row.deposit_address),
        txId: row.tx_id,
        confirmations: row.confirmations,
        requiredConfirmations: row.required_confirmations,
        orderStatus: row.order_status,
        fundsStatus: row.funds_status,
        riskStatus: row.risk_status,
        riskReasons: row.risk_reasons_json,
        ledgerTransactionId: row.ledger_transaction_id,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        externalReceivedAt: row.external_received_at?.toISOString() ?? null,
        creditedAt: row.credited_at?.toISOString() ?? null,
        returnedAt: row.returned_at?.toISOString() ?? null,
      },
      actionRequests: actions.rows.map((action) => ({
        id: action.id,
        action: action.action,
        status: action.status,
        reason: action.reason,
        requestedByUserId: action.requested_by_user_id,
        requestedAt: action.requested_at.toISOString(),
        completedAt: action.completed_at?.toISOString() ?? null,
        decisions: action.decisions,
      })),
      piiRevealed: canRevealPii,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
