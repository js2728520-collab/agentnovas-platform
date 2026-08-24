import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { MarketSourceSelection } from "../packages/contracts/src/market-source-binding.ts";
import {
  isMarketVisible,
  registeredEquityProviders,
  registeredExchangeProviders,
  registeredMarkets,
  type MarketVisibility,
} from "../packages/contracts/src/market-provider-registry.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type MarketSourcePreference = {
  marketId: string;
  selection: MarketSourceSelection;
  updatedAt: string;
};

type PreferenceRow = {
  market_id: string;
  selection_mode: MarketSourceSelection["mode"];
  account_id: string | null;
  provider_id: string | null;
  updated_at: Date;
};

function view(row: PreferenceRow): MarketSourcePreference {
  return {
    marketId: row.market_id,
    selection: row.selection_mode === "account_aligned"
      ? { mode: "account_aligned", accountId: row.account_id! }
      : { mode: "independent", providerId: row.provider_id! },
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 某个市场上客户可选的行情源。未登记的 provider 不出现在这里，也就无法被选中。 */
export function selectableProvidersForMarket(marketId: string): string[] {
  const providers = [...registeredExchangeProviders(), ...registeredEquityProviders()];
  return providers.filter((provider) => provider.marketIds.includes(marketId)).map((provider) => provider.id);
}

/**
 * 校验一次偏好选择。
 *
 * 三道检查各自防一件事：市场必须已登记且当前可见（否则客户能给一个自己看不到的市场设
 * 偏好）；provider 必须登记在该市场下（否则偏好指向一个不存在的组合，解析时才发现）；
 * 账户必须属于本人且可读（跨账户取行情是越权，不可读的账户取不到数据）。
 */
export async function assertSelectableMarketSource(
  database: Queryable,
  input: {
    ownerUserId: string;
    marketId: string;
    selection: MarketSourceSelection;
    visibility: MarketVisibility;
  },
): Promise<void> {
  const known = registeredMarkets().some((market) => market.id === input.marketId);
  if (!known) throw new ResearchApiError("MARKET_NOT_REGISTERED", "该市场未登记", 404);
  if (!isMarketVisible(input.marketId, input.visibility)) {
    throw new ResearchApiError("MARKET_NOT_VISIBLE", "该市场当前不可见", 404);
  }

  if (input.selection.mode === "independent") {
    if (!selectableProvidersForMarket(input.marketId).includes(input.selection.providerId)) {
      throw new ResearchApiError("MARKET_SOURCE_NOT_AVAILABLE", "该行情源不支持这个市场", 422);
    }
    return;
  }

  const account = await database.query<{ customer_id: string; status: string; can_read: number }>(
    "SELECT customer_id, status, can_read FROM exchange_accounts WHERE id = $1",
    [input.selection.accountId],
  );
  const row = account.rows[0];
  // 账户不存在与账户属于别人返回同一个 404：区分开会把「这个账户 ID 存在」泄露出去。
  if (!row || row.customer_id !== input.ownerUserId) {
    throw new ResearchApiError("EXCHANGE_ACCOUNT_NOT_FOUND", "交易所账户不存在", 404);
  }
  if (row.status !== "active" || row.can_read !== 1) {
    throw new ResearchApiError("EXCHANGE_ACCOUNT_UNAVAILABLE", "该交易所账户当前不可用于取行情", 422);
  }
}

export async function listMarketSourcePreferences(
  database: Queryable,
  ownerUserId: string,
): Promise<MarketSourcePreference[]> {
  const result = await database.query<PreferenceRow>(`
    SELECT market_id, selection_mode, account_id, provider_id, updated_at
      FROM customer_market_source_preferences
     WHERE owner_user_id = $1
     ORDER BY market_id
  `, [ownerUserId]);
  return result.rows.map(view);
}

export async function loadMarketSourcePreference(
  database: Queryable,
  input: { ownerUserId: string; marketId: string },
): Promise<MarketSourcePreference | null> {
  const result = await database.query<PreferenceRow>(`
    SELECT market_id, selection_mode, account_id, provider_id, updated_at
      FROM customer_market_source_preferences
     WHERE owner_user_id = $1 AND market_id = $2
  `, [input.ownerUserId, input.marketId]);
  return result.rows[0] ? view(result.rows[0]) : null;
}

/**
 * 保存偏好。
 *
 * 这是**可变**写入，与 0078 的绑定不同：改偏好不会动任何既有部署的绑定，因此不需要
 * 幂等键或冲突检查。历史决策依据哪个源，已经固定在绑定里了。
 */
export async function saveMarketSourcePreference(
  database: Queryable,
  input: { ownerUserId: string; marketId: string; selection: MarketSourceSelection },
): Promise<MarketSourcePreference> {
  const accountId = input.selection.mode === "account_aligned" ? input.selection.accountId : null;
  const providerId = input.selection.mode === "independent" ? input.selection.providerId : null;
  const result = await database.query<PreferenceRow>(`
    INSERT INTO customer_market_source_preferences (
      id, owner_user_id, market_id, selection_mode, account_id, provider_id
    ) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (owner_user_id, market_id) DO UPDATE
      SET selection_mode = EXCLUDED.selection_mode,
          account_id = EXCLUDED.account_id,
          provider_id = EXCLUDED.provider_id,
          updated_at = now()
    RETURNING market_id, selection_mode, account_id, provider_id, updated_at
  `, [randomUUID(), input.ownerUserId, input.marketId, input.selection.mode, accountId, providerId]);
  return view(result.rows[0]);
}
