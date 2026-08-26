import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { ResolvedMarketSourceBinding } from "../packages/contracts/src/market-source-binding.ts";
import { ResearchApiError } from "./research-errors.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export type PersistedMarketSourceBinding = {
  deploymentId: string;
  ownerUserId: string;
  strategyVersionId: string;
  marketId: string;
  instrumentId: string;
  selectionMode: "account_aligned" | "independent";
  providerId: string;
  providerSymbol: string;
  accountId: string | null;
  sourceAccountId: string | null;
  requestedUsage: "display" | "research";
  authorization: "public" | "licensed" | "customer_account";
  capabilityVersionId: string;
  sourcePolicyFingerprint: string;
  bindingInstanceFingerprint: string;
  /** `legacy_unpinned` 表示这条记录早于源绑定功能，从未经过真实解析。 */
  pinning: "pinned" | "legacy_unpinned";
};

type BindingRow = {
  deployment_id: string;
  owner_user_id: string;
  strategy_version_id: string;
  market_id: string;
  instrument_id: string;
  selection_mode: PersistedMarketSourceBinding["selectionMode"];
  provider_id: string;
  provider_symbol: string;
  account_id: string | null;
  source_account_id: string | null;
  requested_usage: PersistedMarketSourceBinding["requestedUsage"];
  authorization_kind: PersistedMarketSourceBinding["authorization"];
  capability_version_id: string;
  source_policy_fingerprint: string;
  binding_instance_fingerprint: string;
  pinning: PersistedMarketSourceBinding["pinning"];
};

function view(row: BindingRow): PersistedMarketSourceBinding {
  return {
    deploymentId: row.deployment_id,
    ownerUserId: row.owner_user_id,
    strategyVersionId: row.strategy_version_id,
    marketId: row.market_id,
    instrumentId: row.instrument_id,
    selectionMode: row.selection_mode,
    providerId: row.provider_id,
    providerSymbol: row.provider_symbol,
    accountId: row.account_id,
    sourceAccountId: row.source_account_id,
    requestedUsage: row.requested_usage,
    authorization: row.authorization_kind,
    capabilityVersionId: row.capability_version_id,
    sourcePolicyFingerprint: row.source_policy_fingerprint,
    bindingInstanceFingerprint: row.binding_instance_fingerprint,
    pinning: row.pinning,
  };
}

/**
 * 把一次解析结果固定到部署上。
 *
 * 幂等按 `bindingInstanceFingerprint` 判定：同一份解析重复保存返回同一行。**不同**的解析
 * 结果落在同一个 (部署, 策略版本) 上则返回 409 而不是覆盖——覆盖等于事后改写「这一轮
 * 依据的是哪个数据源」，决策轮的证据链就断了。
 *
 * 唯一允许的写入是 legacy_unpinned → pinned：历史记录补上真实解析结果。
 */
export async function pinMarketSourceBinding(
  database: Queryable,
  input: { deploymentId: string; ownerUserId: string; binding: ResolvedMarketSourceBinding; instrumentId: string; marketId: string },
): Promise<PersistedMarketSourceBinding> {
  const { binding } = input;
  const existing = await database.query<BindingRow>(`
    SELECT deployment_id, owner_user_id, strategy_version_id, market_id, instrument_id,
           selection_mode, provider_id, provider_symbol, account_id, source_account_id,
           requested_usage, authorization_kind, capability_version_id,
           source_policy_fingerprint, binding_instance_fingerprint, pinning
      FROM strategy_market_source_bindings
     WHERE deployment_id = $1 AND strategy_version_id = $2
  `, [input.deploymentId, binding.strategyVersionId]);

  const current = existing.rows[0];
  if (current) {
    if (current.pinning === "pinned") {
      if (current.binding_instance_fingerprint === binding.bindingInstanceFingerprint) {
        return view(current);
      }
      throw new ResearchApiError(
        "MARKET_SOURCE_BINDING_CONFLICT",
        "该部署已固定到另一个行情源解析结果；换源必须使用新的策略版本",
        409,
      );
    }
    // legacy_unpinned → pinned 是唯一允许的改写，由数据库触发器同样把关。
    const upgraded = await database.query<BindingRow>(`
      UPDATE strategy_market_source_bindings
         SET market_id=$3, instrument_id=$4, selection_mode=$5, provider_id=$6,
             provider_symbol=$7, account_id=$8, source_account_id=$9, requested_usage=$10,
             authorization_kind=$11, capability_version_id=$12,
             source_policy_fingerprint=$13, binding_instance_fingerprint=$14, pinning='pinned'
       WHERE deployment_id=$1 AND strategy_version_id=$2
       RETURNING deployment_id, owner_user_id, strategy_version_id, market_id, instrument_id,
                 selection_mode, provider_id, provider_symbol, account_id, source_account_id,
                 requested_usage, authorization_kind, capability_version_id,
                 source_policy_fingerprint, binding_instance_fingerprint, pinning
    `, [
      input.deploymentId, binding.strategyVersionId, input.marketId, input.instrumentId,
      binding.selectionMode, binding.providerId, binding.providerSymbol, binding.accountId,
      binding.sourceAccountId, binding.requestedUsage, binding.authorization,
      binding.capabilityVersionId, binding.sourcePolicyFingerprint, binding.bindingInstanceFingerprint,
    ]);
    return view(upgraded.rows[0]);
  }

  const inserted = await database.query<BindingRow>(`
    INSERT INTO strategy_market_source_bindings (
      id, deployment_id, owner_user_id, strategy_version_id, market_id, instrument_id,
      selection_mode, provider_id, provider_symbol, account_id, source_account_id,
      requested_usage, authorization_kind, capability_version_id,
      source_policy_fingerprint, binding_instance_fingerprint, pinning
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pinned')
    RETURNING deployment_id, owner_user_id, strategy_version_id, market_id, instrument_id,
              selection_mode, provider_id, provider_symbol, account_id, source_account_id,
              requested_usage, authorization_kind, capability_version_id,
              source_policy_fingerprint, binding_instance_fingerprint, pinning
  `, [
    randomUUID(), input.deploymentId, input.ownerUserId, binding.strategyVersionId,
    input.marketId, input.instrumentId, binding.selectionMode, binding.providerId,
    binding.providerSymbol, binding.accountId, binding.sourceAccountId, binding.requestedUsage,
    binding.authorization, binding.capabilityVersionId,
    binding.sourcePolicyFingerprint, binding.bindingInstanceFingerprint,
  ]);
  return view(inserted.rows[0]);
}

export async function loadMarketSourceBinding(
  database: Queryable,
  input: { deploymentId: string; strategyVersionId: string },
): Promise<PersistedMarketSourceBinding | null> {
  const result = await database.query<BindingRow>(`
    SELECT deployment_id, owner_user_id, strategy_version_id, market_id, instrument_id,
           selection_mode, provider_id, provider_symbol, account_id, source_account_id,
           requested_usage, authorization_kind, capability_version_id,
           source_policy_fingerprint, binding_instance_fingerprint, pinning
      FROM strategy_market_source_bindings
     WHERE deployment_id = $1 AND strategy_version_id = $2
  `, [input.deploymentId, input.strategyVersionId]);
  return result.rows[0] ? view(result.rows[0]) : null;
}

export type RoundBindingConsistency =
  | { consistent: true; sourcePolicyFingerprint: string | null; deploymentCount: number }
  | { consistent: false; fingerprints: string[]; deploymentCount: number };

/**
 * 共享决策轮的绑定一致性守卫。
 *
 * ADR-0018 让同一张卡在同一根 K 线上只判断一次，决策轮身份是
 * `(strategy_code, symbol, timeframe, candle_close_time)`——**不含数据源**。只要所有订阅者
 * 用同一个源，这没问题；一旦有人换了源，同一轮就会拿 A 源的判断解释 B 源的行情。
 *
 * 当前所有部署都走同一个公共源，所以这是**潜在**而非已发生的问题。把它做成显式守卫而
 * 不是等以后再说：真正的修法是把 source policy fingerprint 纳入决策轮身份（那会改动
 * ADR-0018 的模型，需要单独规划），在那之前 Runtime 必须在发现分叉时失败关闭，而不是
 * 悄悄让两个源共享一轮。
 *
 * `legacy_unpinned` 记录不参与一致性判定——它们本来就没有解析结果，用全零 fingerprint
 * 去比对只会得出假冲突。
 */
export async function assertRoundBindingConsistency(
  database: Queryable,
  input: { strategyCode: string; symbol: string; strategyVersionId: string },
): Promise<RoundBindingConsistency> {
  const result = await database.query<{ source_policy_fingerprint: string; deployments: string }>(`
    SELECT binding.source_policy_fingerprint, count(*)::text AS deployments
      FROM strategy_market_source_bindings AS binding
      JOIN strategy_deployments AS deployment ON deployment.id = binding.deployment_id
     WHERE deployment.platform_strategy_code = $1
       AND binding.instrument_id = $2
       AND binding.strategy_version_id = $3
       AND binding.pinning = 'pinned'
     GROUP BY binding.source_policy_fingerprint
  `, [input.strategyCode, input.symbol, input.strategyVersionId]);

  const deploymentCount = result.rows.reduce((total, row) => total + Number(row.deployments), 0);
  if (result.rows.length <= 1) {
    return {
      consistent: true,
      sourcePolicyFingerprint: result.rows[0]?.source_policy_fingerprint ?? null,
      deploymentCount,
    };
  }
  return {
    consistent: false,
    fingerprints: result.rows.map((row) => row.source_policy_fingerprint).sort(),
    deploymentCount,
  };
}
