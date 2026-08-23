/**
 * 用钱包余额支付绩效分成账单。
 *
 * 与会员那条同源（`membership-wallet-payment.ts`）：钱包里的钱已经在系统里，且进来时
 * 走过一次充值的双人复核，再要求第二个人批准「客户花自己的钱」是没有对应风险的摩擦。
 *
 * 但绩效分成多一件会员没有的事：**推进高水位线**。
 *
 * 高水位线决定下一期从哪里开始算分成。付了款却不推进，客户会被就同一段盈利重复收费；
 * 推进了却没收到款，平台白白放弃了这一段的收费权。两者必须在同一个事务里，
 * 而且必须与站外付款路径推进得一模一样（INV-5 口径一致）。
 */

import type { Pool, PoolClient } from "pg";

import {
  ensurePlatformLedgerAccount,
  ensureUserAvailableLedgerAccount,
  postCommercialLedgerTransaction,
} from "./commercial-ledger-service.ts";
import { ResearchApiError } from "./research-errors.ts";

export type WalletPerformancePaymentInput = {
  statementId: string;
  /** 付款人。必须是账单本人。 */
  userId: string;
  idempotencyKey: string;
  requestId: string;
};

type StatementRow = {
  id: string;
  user_id: string;
  status: string;
  cumulative_net_pnl: string;
  fee_amount: string;
  currency: string;
};

export async function payPerformanceStatementFromWallet(
  pool: Pool,
  input: WalletPerformancePaymentInput,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await runWalletPayment(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof Error && error.message === "WALLET_BALANCE_INSUFFICIENT") {
      throw new ResearchApiError("WALLET_BALANCE_INSUFFICIENT", "钱包余额不足，请先充值", 402);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function runWalletPayment(client: PoolClient, input: WalletPerformancePaymentInput) {
  const row = (await client.query<StatementRow>(
    `SELECT id,user_id,status,cumulative_net_pnl::text,fee_amount::text,currency
       FROM performance_fee_statements WHERE id=$1 FOR UPDATE`,
    [input.statementId],
  )).rows[0];
  if (!row) throw new ResearchApiError("STATEMENT_NOT_FOUND", "绩效账单不存在", 404);
  // 只能付自己的账单。返回「不存在」而不是「无权」——后者等于确认了这张账单存在。
  if (row.user_id !== input.userId) {
    throw new ResearchApiError("STATEMENT_NOT_FOUND", "绩效账单不存在", 404);
  }
  // 只有已批准待付款的账单可以支付。pending_review 还没定金额，paid 已经付过。
  if (row.status !== "payment_pending") {
    throw new ResearchApiError(
      "STATEMENT_NOT_PAYABLE",
      row.status === "paid" ? "该账单已结清" : "该账单尚未进入待付款状态",
      409,
    );
  }

  // 与站外路径同一把锁：高水位线是分成口径的核心，任何并发都必须在这里串行化。
  await client.query(
    "SELECT 1 FROM performance_fee_high_water_marks WHERE user_id=$1 FOR UPDATE",
    [row.user_id],
  );

  const userAccountId = await ensureUserAvailableLedgerAccount(client, row.user_id, "USDT");
  const feeId = await ensurePlatformLedgerAccount(client, "platform_fee", "USDT");

  const ledger = await postCommercialLedgerTransaction(client, {
    transactionType: "performance_fee_payment",
    sourceType: "performance_fee_statement",
    sourceId: input.statementId,
    currency: "USDT",
    // 与站外路径共用同一个幂等键：同一张账单无论走哪条路，账本上只可能有一笔。
    idempotencyKey: `performance-paid:${input.statementId}`,
    requestId: input.requestId,
    createdByUserId: row.user_id,
    postings: [
      // 客户账户 借 / 手续费账户 贷。写成「清算账户 借」会让客户对平台的债权永远
      // 挂着——钱包扣了，账本上没减少。
      { accountId: userAccountId, side: "debit", amount: row.fee_amount },
      { accountId: feeId, side: "credit", amount: row.fee_amount },
    ],
    walletMutation: { userId: row.user_id, availableDelta: `-${row.fee_amount}`, frozenDelta: "0" },
    metadata: { statementId: input.statementId, paymentMethod: "wallet" },
    audit: {
      action: "commercial.performance.paid",
      subjectType: "performance_fee_statement",
      subjectId: input.statementId,
      before: { status: "payment_pending" },
      after: { status: "paid", paymentMethod: "wallet" },
    },
  });

  // 推进高水位线。
  //
  // 这一步与站外路径逐字相同，是刻意的：两条路推进得不一样，客户走哪条路缴费会影响
  // 下一期收多少——那是最难发现也最难解释的分成错误（INV-5）。
  await client.query(
    `UPDATE performance_fee_high_water_marks
        SET cumulative_net_pnl=$2,
            high_water_mark=GREATEST(high_water_mark,$2::numeric),
            last_paid_statement_id=$3,
            version=version+1,
            updated_at=now()
      WHERE user_id=$1`,
    [row.user_id, row.cumulative_net_pnl, input.statementId],
  );

  await client.query(
    "UPDATE performance_fee_receivables SET status='paid',paid_at=now() WHERE statement_id=$1",
    [input.statementId],
  );
  await client.query(
    "UPDATE performance_fee_statements SET status='paid',ledger_transaction_id=$2,updated_at=now() WHERE id=$1",
    [input.statementId, ledger.id],
  );

  return {
    status: "paid" as const,
    statementId: input.statementId,
    ledgerTransactionId: ledger.id,
    paymentMethod: "wallet" as const,
  };
}
