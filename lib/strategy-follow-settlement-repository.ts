import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { settleFollowWeek } from "../packages/domain/src/strategy-follow-settlement.ts";
import { ResearchApiError } from "./research-errors.ts";

export type FollowSettlementRecord = {
  id: string;
  contractId: string;
  weekStart: string;
  weekEnd: string;
  feeAmount: string;
  platformAmount: string;
  authorAmount: string;
  priorHighWaterMark: string;
  nextHighWaterMark: string;
  status: string;
  revision: number;
  replayed: boolean;
};

type SettlementRow = {
  id: string;
  contract_id: string;
  week_start: Date;
  week_end: Date;
  fee_amount: string;
  platform_amount: string;
  author_amount: string;
  prior_high_water_mark: string;
  next_high_water_mark: string;
  status: string;
  revision: number;
};

const view = (row: SettlementRow, replayed: boolean): FollowSettlementRecord => ({
  id: row.id,
  contractId: row.contract_id,
  weekStart: row.week_start.toISOString(),
  weekEnd: row.week_end.toISOString(),
  feeAmount: row.fee_amount,
  platformAmount: row.platform_amount,
  authorAmount: row.author_amount,
  priorHighWaterMark: row.prior_high_water_mark,
  nextHighWaterMark: row.next_high_water_mark,
  status: row.status,
  revision: row.revision,
  replayed,
});

const RETURNING = `
  id, contract_id, week_start, week_end, fee_amount, platform_amount, author_amount,
  prior_high_water_mark, next_high_water_mark, status, revision
`;

/**
 * 结算某份跟单合同的某一个 UTC 自然周。
 *
 * **必须在事务里调用**，并且高水位线先加锁再读——两个 Worker 同时结算同一份合同会各自
 * 读到同一个旧高水位线，于是同一段涨幅被收两次费。锁的是 (客户, 策略) 那一行。
 *
 * 幂等按 (合同, 周) 判定：重复结算返回原单且**不再推进高水位线**。这是这个函数最关键的
 * 性质——推进两次会让下一周的计费基准凭空抬高，客户少付一笔而作者少拿一笔，且没有任何
 * 地方会报错。
 */
export async function settleFollowContractWeek(
  client: PoolClient,
  input: {
    contractId: string;
    weekStart: string;
    weekEnd: string;
    weekNetPnl: string;
    cumulativeNetPnl: string;
  },
): Promise<FollowSettlementRecord> {
  const contract = (await client.query<{
    id: string; customer_id: string; strategy_id: string; author_user_id: string;
    performance_fee_bps: number; platform_share_bps: number;
    publication_mode: "marketplace" | "self_use";
  }>(`
    SELECT id, customer_id, strategy_id, author_user_id,
           performance_fee_bps, platform_share_bps, publication_mode
      FROM strategy_follow_contracts WHERE id = $1
  `, [input.contractId])).rows[0];
  if (!contract) throw new ResearchApiError("FOLLOW_CONTRACT_NOT_FOUND", "跟单合同不存在", 404);

  // 幂等检查放在推进高水位线之前。放在之后就会先推进再发现已经算过。
  const existing = (await client.query<SettlementRow>(`
    SELECT ${RETURNING} FROM strategy_follow_settlements
     WHERE contract_id = $1 AND week_start = $2
     ORDER BY revision DESC LIMIT 1
  `, [input.contractId, input.weekStart])).rows[0];
  if (existing) return view(existing, true);

  // 先建行再加锁：ON CONFLICT DO NOTHING 之后的 SELECT ... FOR UPDATE 才有行可锁。
  await client.query(`
    INSERT INTO strategy_follow_high_water_marks (customer_id, strategy_id)
    VALUES ($1,$2) ON CONFLICT DO NOTHING
  `, [contract.customer_id, contract.strategy_id]);
  const mark = (await client.query<{ high_water_mark: string }>(`
    SELECT high_water_mark::text FROM strategy_follow_high_water_marks
     WHERE customer_id = $1 AND strategy_id = $2 FOR UPDATE
  `, [contract.customer_id, contract.strategy_id])).rows[0];

  const settlement = settleFollowWeek({
    weekNetPnl: input.weekNetPnl,
    cumulativeNetPnl: input.cumulativeNetPnl,
    priorHighWaterMark: mark.high_water_mark,
    feeBps: contract.performance_fee_bps,
    platformShareBps: contract.platform_share_bps,
    publicationMode: contract.publication_mode,
  });

  const inserted = (await client.query<SettlementRow>(`
    INSERT INTO strategy_follow_settlements (
      id, contract_id, customer_id, strategy_id, author_user_id, week_start, week_end,
      week_net_pnl, cumulative_net_pnl, prior_high_water_mark, next_high_water_mark,
      eligible_profit, loss_carry, fee_bps, fee_amount, platform_amount, author_amount, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING ${RETURNING}
  `, [
    randomUUID(), contract.id, contract.customer_id, contract.strategy_id, contract.author_user_id,
    input.weekStart, input.weekEnd, settlement.weekNetPnl, settlement.cumulativeNetPnl,
    settlement.priorHighWaterMark, settlement.nextHighWaterMark, settlement.eligibleProfit,
    settlement.lossCarry, settlement.feeBps, settlement.feeAmount,
    settlement.platformAmount, settlement.authorAmount,
    // 零费用周也出单，状态是 no_fee 而不是 pending_review——没有钱要审的东西不该占审批队列。
    settlement.hasFee ? "pending_review" : "no_fee",
  ])).rows[0];

  await client.query(`
    UPDATE strategy_follow_high_water_marks
       SET cumulative_net_pnl = $3::numeric,
           high_water_mark = GREATEST(high_water_mark, $4::numeric),
           updated_at = now()
     WHERE customer_id = $1 AND strategy_id = $2
  `, [contract.customer_id, contract.strategy_id, settlement.cumulativeNetPnl, settlement.nextHighWaterMark]);

  return view(inserted, false);
}
