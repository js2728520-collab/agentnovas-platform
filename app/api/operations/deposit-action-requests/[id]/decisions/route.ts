import { requireAccessPermission } from "@/lib/access-control";
import { idempotencyKey } from "@/lib/commercial-api";
import {
  ensurePlatformLedgerAccount,
  ensureUserAvailableLedgerAccount,
  postCommercialLedgerTransaction,
} from "@/lib/commercial-ledger-service";
import { compareDecimalStrings } from "@/lib/ledger";
import { customerScopePredicate } from "@/lib/operations-access";
import { getPostgresPool } from "@/lib/postgres";
import { readResearchJson, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { user, scope, organizationIds } = await requireAccessPermission(request, "ops.deposits.action_approve");
    idempotencyKey(request);
    const { id } = await context.params;
    const body = await readResearchJson(request, 4_096);
    const decision = String(body.decision ?? "");
    if (decision !== "approve" && decision !== "reject") throw new ResearchApiError("VALIDATION_ERROR", "审批决定无效", 422, { fields: ["decision"] });
    const note = String(body.note ?? "").trim().slice(0, 500);
    if (!note) throw new ResearchApiError("VALIDATION_ERROR", "必须填写审批意见", 422, { fields: ["note"] });
    const client = await (await getPostgresPool()).connect();
    let fundsExecuted = false;
    let ledgerTransactionId: string | null = null;
    try {
      await client.query("BEGIN");
      const scoped = customerScopePredicate(scope, { userId: user.id, organizationId: user.organizationId }, "d", "d.user_id", 2, organizationIds);
      const action = await client.query<{
        requested_by_user_id: string; status: string; action: string; deposit_order_id: string;
        deposit_user_id: string; currency: string; actual_amount: string | null; risk_status: string;
        order_status: string; existing_ledger_transaction_id: string | null;
      }>(`
        SELECT ar.requested_by_user_id,ar.status,ar.action,ar.deposit_order_id,
          d.user_id AS deposit_user_id,d.currency,d.actual_amount::text,d.risk_status,d.order_status,
          d.ledger_transaction_id AS existing_ledger_transaction_id
        FROM deposit_action_requests ar INNER JOIN deposit_orders d ON d.id=ar.deposit_order_id
        WHERE ar.id=$1 AND ${scoped.clause} FOR UPDATE OF ar,d
      `, [id, ...scoped.values]);
      const row = action.rows[0];
      if (!row) throw new ResearchApiError("NOT_FOUND", "人工操作申请不存在", 404);
      if (row.requested_by_user_id === user.id) throw new ResearchApiError("FORBIDDEN", "申请人不能审批自己的资金操作", 403);
      if (row.status !== "pending") throw new ResearchApiError("CONFLICT", "该申请已处理", 409);
      await client.query(`INSERT INTO deposit_action_decisions(id,request_id,reviewer_user_id,decision,note)
        VALUES($1,$2,$3,$4,$5)`, [crypto.randomUUID(), id, user.id, decision, note]);

      if (decision === "approve" && row.action === "APPROVE_CREDIT") {
        if (row.risk_status === "BLOCK") throw new ResearchApiError("DEPOSIT_RISK_BLOCKED", "风控阻断的充值不能入账", 409);
        if (row.order_status !== "MANUAL_REVIEW" || row.existing_ledger_transaction_id) {
          throw new ResearchApiError("CONFLICT", "充值订单当前状态不允许入账", 409);
        }
        if (!row.actual_amount || compareDecimalStrings(row.actual_amount, "0") <= 0) {
          throw new ResearchApiError("CONFLICT", "充值订单缺少有效的实际到账金额", 409);
        }
        const clearingAccountId = await ensurePlatformLedgerAccount(client, "platform_deposit_clearing", row.currency);
        const userAccountId = await ensureUserAvailableLedgerAccount(client, row.deposit_user_id, row.currency);
        const ledger = await postCommercialLedgerTransaction(client, {
          transactionType: "deposit_credit",
          sourceType: "deposit_order",
          sourceId: row.deposit_order_id,
          currency: row.currency,
          idempotencyKey: `deposit-credit:${row.deposit_order_id}`,
          requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
          createdByUserId: user.id,
          postings: [
            { accountId: clearingAccountId, side: "debit", amount: row.actual_amount },
            { accountId: userAccountId, side: "credit", amount: row.actual_amount },
          ],
          walletMutation: { userId: row.deposit_user_id, availableDelta: row.actual_amount, frozenDelta: "0" },
          metadata: { provider: "udun", approvalRequestId: id },
          audit: {
            action: "deposit.credit_posted",
            subjectType: "deposit_order",
            subjectId: row.deposit_order_id,
            before: { orderStatus: row.order_status, fundsStatus: "NOT_CREDITED" },
            after: { orderStatus: "CREDITED", fundsStatus: "AVAILABLE", amount: row.actual_amount },
          },
          outbox: {
            userId: row.deposit_user_id,
            category: "deposit",
            templateKey: "deposit_credited",
            payload: { depositOrderId: row.deposit_order_id, amount: row.actual_amount, currency: row.currency },
            dedupeKey: `deposit-credited:${row.deposit_order_id}`,
          },
        });
        const credited = await client.query(`UPDATE deposit_orders SET order_status='CREDITED',funds_status='AVAILABLE',
          risk_status='PASS',credited_amount=actual_amount,ledger_transaction_id=$2,credited_at=now(),updated_at=now()
          WHERE id=$1 AND ledger_transaction_id IS NULL AND order_status='MANUAL_REVIEW' RETURNING id`, [row.deposit_order_id, ledger.id]);
        if (!credited.rows[0]) throw new ResearchApiError("CONFLICT", "充值订单已被其他操作处理", 409);
        fundsExecuted = true;
        ledgerTransactionId = ledger.id;
      }

      const updated = await client.query(`UPDATE deposit_action_requests SET status=$1,completed_at=now()
        WHERE id=$2 AND status='pending' RETURNING id`, [decision === "approve" ? "approved" : "rejected", id]);
      if (!updated.rows[0]) throw new ResearchApiError("CONFLICT", "该申请已被其他审批人处理", 409);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return Response.json({
      ok: true,
      status: decision === "approve" ? "approved" : "rejected",
      fundsExecuted,
      ledgerTransactionId,
      message: fundsExecuted ? "审批完成，充值已通过不可变账本入账" : "审批记录已保存，未执行资金变更",
    });
  } catch (error) {
    return researchErrorResponse(error, request);
  }
}
