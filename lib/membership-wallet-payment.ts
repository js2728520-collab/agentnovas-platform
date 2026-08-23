/**
 * 用钱包余额购买会员。
 *
 * 现有的开通路径（`decideMembershipOrder`）为**站外付款**而设计：运营录入付款凭证，
 * 第二个人核对后放行。那套 maker/checker 存在的理由是钱从系统外面进来，没人能自动
 * 确认它真的到了。
 *
 * 钱包余额不一样——那笔钱**已经在系统里**，而且它进来时就走过一次双人复核
 * （充值入账）。再要求第二个人批准一次「客户花自己的钱」，是没有对应风险的摩擦。
 * 所以这条路径是客户自助、即时生效的。
 *
 * 分录与充值入账严格对称（INV-4 借贷必平）：
 *
 *   充值：平台清算账户 借 / 客户账户 贷，钱包 +amount
 *   购买：客户账户    借 / 手续费账户 贷，钱包 −price
 *
 * 写成 `platform_deposit_clearing 借` 会让客户账户上的余额永远挂着——账面上钱包扣了，
 * 账本上客户对平台的债权没减少，两边对不上。
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  ensurePlatformLedgerAccount,
  ensureUserAvailableLedgerAccount,
  postCommercialLedgerTransaction,
} from "./commercial-ledger-service.ts";
import { mutateAiCredits } from "./ai-credit-service.ts";
import { ResearchApiError } from "./research-errors.ts";

export type WalletMembershipPaymentInput = {
  orderId: string;
  /** 付款人。必须是订单本人——不能替别人花钱。 */
  userId: string;
  idempotencyKey: string;
  requestId: string;
  now?: Date;
};

type OrderRow = {
  id: string;
  user_id: string;
  status: string;
  plan_version_id: string;
  duration_days: number | null;
  ai_credit_grant: string;
  price_amount: string;
  price_currency: string;
};

export async function payMembershipOrderFromWallet(
  pool: Pool,
  input: WalletMembershipPaymentInput,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await runWalletPayment(client, input);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    // 余额不足是业务结果，不是系统故障。让它以 402 出去，前端才能提示「去充值」。
    if (error instanceof Error && error.message === "WALLET_BALANCE_INSUFFICIENT") {
      throw new ResearchApiError("WALLET_BALANCE_INSUFFICIENT", "钱包余额不足，请先充值", 402);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function runWalletPayment(client: PoolClient, input: WalletMembershipPaymentInput) {
  const order = (await client.query<OrderRow>(
    `SELECT id,user_id,status,plan_version_id,duration_days,ai_credit_grant::text,
            price_amount::text,price_currency
       FROM commercial_membership_orders WHERE id=$1 FOR UPDATE`,
    [input.orderId],
  )).rows[0];
  if (!order) throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
  // 只能付自己的订单。没有这一条，任何人拿到订单号就能用自己的余额替别人开通会员。
  if (order.user_id !== input.userId) {
    throw new ResearchApiError("ORDER_NOT_FOUND", "会员订单不存在", 404);
  }
  // 只有还没进入站外付款审核流程的订单可以走钱包。已经录了凭证的订单继续走原路径，
  // 否则会出现「钱包扣了一次、站外又付了一次」。
  if (order.status !== "pending_evidence") {
    throw new ResearchApiError(
      "ORDER_NOT_PAYABLE",
      order.status === "activated" ? "该订单已开通" : "该订单已进入人工付款审核，不能再用钱包支付",
      409,
    );
  }

  // 锁客户行，与现有路径一致：同一客户的并发订单在这里串行化。
  await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [order.user_id]);

  const memberships = (await client.query<{ id: string; commercial_plan_code: string | null }>(
    `SELECT id, plan_code AS commercial_plan_code FROM memberships
      WHERE customer_id=$1 AND status IN ('active','pending') FOR UPDATE`,
    [order.user_id],
  )).rows;
  if (memberships.length > 1) {
    throw new ResearchApiError("MEMBERSHIP_INTEGRITY_CONFLICT", "客户存在多个当前会员权益", 409);
  }
  const before = memberships[0] ?? null;
  if (before?.commercial_plan_code === "lifetime_v1" && order.duration_days !== null) {
    throw new ResearchApiError("LIFETIME_DOWNGRADE_FORBIDDEN", "终身会员不得被有限期计划降级", 409);
  }

  const membershipId = before?.id ?? randomUUID();
  const now = input.now ?? new Date();
  const expiresAt = order.duration_days === null
    ? null
    : new Date(now.getTime() + order.duration_days * 86_400_000).toISOString();

  const userAccountId = await ensureUserAvailableLedgerAccount(client, order.user_id, order.price_currency);
  const feeId = await ensurePlatformLedgerAccount(client, "platform_fee", order.price_currency);

  const ledger = await postCommercialLedgerTransaction(client, {
    transactionType: "membership_purchase",
    sourceType: "commercial_membership_order",
    sourceId: order.id,
    currency: order.price_currency,
    // 与站外付款路径共用同一个幂等键前缀：同一张订单无论走哪条路，
    // 账本上只可能有一笔 membership_purchase。
    idempotencyKey: `membership-ledger:${order.id}`,
    requestId: input.requestId,
    createdByUserId: order.user_id,
    metadata: { orderId: order.id, planVersionId: order.plan_version_id, paymentMethod: "wallet" },
    postings: [
      { accountId: userAccountId, side: "debit", amount: order.price_amount },
      { accountId: feeId, side: "credit", amount: order.price_amount },
    ],
    // 余额不足时这里抛 WALLET_BALANCE_INSUFFICIENT，整笔事务回滚。
    walletMutation: { userId: order.user_id, availableDelta: `-${order.price_amount}`, frozenDelta: "0" },
    audit: {
      action: "commercial.membership.activated",
      subjectType: "commercial_membership_order",
      subjectId: order.id,
      before: { status: order.status },
      after: { status: "activated", membershipId, paymentMethod: "wallet" },
    },
    outbox: {
      userId: order.user_id,
      category: "membership",
      templateKey: "membership_activated",
      payload: { orderId: order.id },
      dedupeKey: `membership-activated:${order.id}`,
    },
  });

  if (before) {
    await client.query(
      `UPDATE memberships SET plan_code=$2,status='active',starts_at=COALESCE(starts_at,$3),
              expires_at=$4,max_active_strategies=3,updated_at=$3 WHERE id=$1`,
      [membershipId, order.plan_version_id, now.toISOString(), expiresAt],
    );
  } else {
    await client.query(
      `INSERT INTO memberships(id,customer_id,plan_code,status,starts_at,expires_at,max_active_strategies)
       VALUES($1,$2,$3,'active',$4,$5,3)`,
      [membershipId, order.user_id, order.plan_version_id, now.toISOString(), expiresAt],
    );
  }

  await mutateAiCredits(client, {
    userId: order.user_id,
    type: "grant",
    availableDelta: BigInt(order.ai_credit_grant),
    reservedDelta: BigInt(0),
    sourceType: "commercial_membership_order",
    sourceId: order.id,
    idempotencyKey: `membership-credit:${order.id}`,
    requestId: input.requestId,
    actorUserId: order.user_id,
  });

  await client.query(
    `INSERT INTO membership_entitlement_events(
       id,membership_id,order_id,user_id,event_type,before_json,after_json,valid_from,valid_until,idempotency_key
     ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
    [
      randomUUID(), membershipId, order.id, order.user_id,
      before ? "renewed" : "activated",
      JSON.stringify(before ?? {}),
      JSON.stringify({ planVersionId: order.plan_version_id, expiresAt, paymentMethod: "wallet" }),
      now, expiresAt, `membership-entitlement:${order.id}`,
    ],
  );

  await client.query(
    `UPDATE commercial_membership_orders
        SET status='activated',approved_membership_id=$2,ledger_transaction_id=$3,
            activated_at=now(),updated_at=now()
      WHERE id=$1`,
    [order.id, membershipId, ledger.id],
  );

  return {
    status: "activated" as const,
    membershipId,
    ledgerTransactionId: ledger.id,
    paymentMethod: "wallet" as const,
  };
}
