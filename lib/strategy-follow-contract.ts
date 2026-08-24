import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { FOLLOW_FEES } from "../packages/contracts/src/product-parameters.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

const bps = (rate: string) => Math.round(Number(rate) * 10_000);

/** P-06 的分账比例。写成 bps 是为了和账本的整数口径一致，不引入浮点。 */
export const PLATFORM_SHARE_BPS = bps(FOLLOW_FEES.platformShareRate);
/** 未覆盖会员权益时的默认绩效费率（P-06）。有会员权益时用会员档位费率。 */
export const DEFAULT_FOLLOW_FEE_BPS = bps(FOLLOW_FEES.performanceFeeRate);

export type FollowContract = {
  id: string;
  subscriptionId: string;
  strategyId: string;
  customerId: string;
  authorUserId: string;
  strategyVersionId: string;
  strategyVersion: number;
  performanceFeeBps: number;
  platformShareBps: number;
  publicationMode: "marketplace" | "self_use";
  risk: Record<string, unknown>;
  confirmedAt: string;
  disclosureSha256: string;
};

type ContractRow = {
  id: string;
  subscription_id: string;
  strategy_id: string;
  customer_id: string;
  author_user_id: string;
  strategy_version_id: string;
  strategy_version: number;
  performance_fee_bps: number;
  platform_share_bps: number;
  publication_mode: FollowContract["publicationMode"];
  risk_json: Record<string, unknown>;
  confirmed_at: Date;
  disclosure_sha256: string;
};

function view(row: ContractRow): FollowContract {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    strategyId: row.strategy_id,
    customerId: row.customer_id,
    authorUserId: row.author_user_id,
    strategyVersionId: row.strategy_version_id,
    strategyVersion: row.strategy_version,
    performanceFeeBps: row.performance_fee_bps,
    platformShareBps: row.platform_share_bps,
    publicationMode: row.publication_mode,
    risk: row.risk_json,
    confirmedAt: row.confirmed_at.toISOString(),
    disclosureSha256: row.disclosure_sha256,
  };
}

/**
 * 解析客户当前的绩效费率。
 *
 * 需求方确认：跟随客户投稿策略用**客户的会员档位费率**，与官方卡一致——客户只需记住一个
 * 费率，高档会员的优惠在广场同样生效。没有覆盖当下的会员权益时回落到 P-06 的 20%。
 *
 * 回落方向是**更贵**而不是更便宜：没有会员就没有优惠，这与「优惠是会员权益」一致。
 */
export async function resolveCustomerFollowFeeBps(
  database: Queryable,
  customerId: string,
  asOf: Date = new Date(),
): Promise<number> {
  const result = await database.query<{ performance_fee_bps: number }>(`
    SELECT o.performance_fee_bps
      FROM membership_entitlement_events e
      JOIN commercial_membership_orders o ON o.id = e.order_id
     WHERE e.user_id = $1
       AND o.status = 'activated'
       AND e.valid_from <= $2
       AND (e.valid_until IS NULL OR e.valid_until >= $2)
     ORDER BY e.valid_from DESC, e.created_at DESC
     LIMIT 1
  `, [customerId, asOf.toISOString()]);
  return result.rows[0]?.performance_fee_bps ?? DEFAULT_FOLLOW_FEE_BPS;
}

/**
 * 客户确认跟随时固定一份合同。
 *
 * 快照的是**客户当时看到并同意的东西**：策略版本、费率、分账比例、风险参数、披露文本
 * 摘要。之后作者改版本、平台改费率、运营改门槛，都不能回头改写这份合同（INV-5）。
 *
 * 一次订阅一份合同，重复确认返回同一份。换版本或换风险参数要结束旧订阅、建新的——
 * 就地改等于事后修改客户同意的内容。
 */
export async function pinFollowContract(
  database: Queryable,
  input: {
    subscriptionId: string;
    strategyId: string;
    customerId: string;
    authorUserId: string;
    strategyVersionId: string;
    strategyVersion: number;
    performanceFeeBps: number;
    publicationMode: "marketplace" | "self_use";
    risk: Record<string, unknown>;
    disclosureText: string;
  },
): Promise<FollowContract> {
  const existing = await loadFollowContract(database, input.subscriptionId);
  if (existing) return existing;
  if (!Number.isInteger(input.performanceFeeBps) || input.performanceFeeBps < 0 || input.performanceFeeBps > 10_000) {
    throw new ResearchApiError("FOLLOW_FEE_BPS_INVALID", "绩效费率快照无效", 422);
  }
  // 披露文本本身不入库——它可能很长且会随版本变化；摘要足以证明客户当时看到的是哪一份。
  const disclosureSha256 = createHash("sha256").update(input.disclosureText, "utf8").digest("hex");
  const inserted = await database.query<ContractRow>(`
    INSERT INTO strategy_follow_contracts (
      id, subscription_id, strategy_id, customer_id, author_user_id,
      strategy_version_id, strategy_version, performance_fee_bps, platform_share_bps,
      subscription_fee_usdt, publication_mode, risk_json, disclosure_sha256
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
    RETURNING id, subscription_id, strategy_id, customer_id, author_user_id,
              strategy_version_id, strategy_version, performance_fee_bps, platform_share_bps,
              publication_mode, risk_json, confirmed_at, disclosure_sha256
  `, [
    randomUUID(), input.subscriptionId, input.strategyId, input.customerId, input.authorUserId,
    input.strategyVersionId, input.strategyVersion, input.performanceFeeBps, PLATFORM_SHARE_BPS,
    FOLLOW_FEES.subscriptionFeeUsdt, input.publicationMode, JSON.stringify(input.risk), disclosureSha256,
  ]);
  return view(inserted.rows[0]);
}

export async function loadFollowContract(
  database: Queryable,
  subscriptionId: string,
): Promise<FollowContract | null> {
  const result = await database.query<ContractRow>(`
    SELECT id, subscription_id, strategy_id, customer_id, author_user_id,
           strategy_version_id, strategy_version, performance_fee_bps, platform_share_bps,
           publication_mode, risk_json, confirmed_at, disclosure_sha256
      FROM strategy_follow_contracts
     WHERE subscription_id = $1
  `, [subscriptionId]);
  return result.rows[0] ? view(result.rows[0]) : null;
}
