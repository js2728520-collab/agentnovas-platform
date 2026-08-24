import type {
  MarketSourceCapabilitySnapshot,
  MarketSourceSelection,
} from "../packages/contracts/src/market-source-binding.ts";
import {
  isOfficialCardStrategyCode,
  officialCardSourceSelection,
  registeredEquityProviders,
  registeredExchangeProviders,
} from "../packages/contracts/src/market-provider-registry.ts";
import type { MarketSourcePreference } from "./market-source-preference-repository.ts";

/**
 * 一次源选择的来源。三者不能合并显示：`platform_default` 是「客户还没选」，
 * `customer_preference` 是「客户选了」，`official_card_platform_source` 是「客户不能选」。
 * 把它们都显示成「当前源」会让客户以为自己的选择生效了（INV-6 的同一类错误）。
 */
export type MarketSourceSelectionOrigin =
  | "official_card_platform_source"
  | "customer_preference"
  | "platform_default";

export type DeploymentSourceSelection = {
  selection: MarketSourceSelection;
  origin: MarketSourceSelectionOrigin;
};

function registeredProviders() {
  return [...registeredExchangeProviders(), ...registeredEquityProviders()];
}

/** 某市场在没有客户偏好时使用的源：注册表里登记于该市场的第一个 provider。 */
export function platformDefaultSelection(marketId: string): MarketSourceSelection | null {
  const provider = registeredProviders().find((entry) => entry.marketIds.includes(marketId));
  return provider ? { mode: "independent", providerId: provider.id } : null;
}

/**
 * 决定一个部署实际使用哪个行情源——ADR-0025 在代码里的形式。
 *
 * 官方策略卡恒用平台指定源，**客户偏好在这里被忽略**。这不是遗漏：ADR-0018 让同一张卡
 * 在同一根 K 线上只判断一次，决策轮身份不含数据源；若按客户偏好换源，同一张卡就会产生
 * 多份互相矛盾的公开叙述。自定义策略各自独立成轮，因此可以用客户偏好。
 */
export function selectionForDeployment(input: {
  platformStrategyCode: string | null;
  marketId: string;
  preference: MarketSourcePreference | null;
}): DeploymentSourceSelection | null {
  if (isOfficialCardStrategyCode(input.platformStrategyCode)) {
    return { selection: officialCardSourceSelection(), origin: "official_card_platform_source" };
  }
  if (input.preference && input.preference.marketId === input.marketId) {
    return { selection: input.preference.selection, origin: "customer_preference" };
  }
  const fallback = platformDefaultSelection(input.marketId);
  return fallback ? { selection: fallback, origin: "platform_default" } : null;
}

/**
 * 从注册表构造能力快照。
 *
 * `configured` 直接取注册表的值——当前全部是 `false`，因为凭证与授权是部署事实，没有
 * 任何 provider 被真正接通过。因此解析目前一律返回 `source_not_configured`，这是如实
 * 报告而不是缺陷：伪装成已配置会让「未配置」看起来像「就绪」（INV-6）。
 */
export function capabilitySnapshotFromRegistry(input: {
  providerId: string;
  marketId: string;
  instrumentId: string;
  providerSymbol: string;
}): MarketSourceCapabilitySnapshot | null {
  const provider = registeredProviders().find((entry) => entry.id === input.providerId);
  if (!provider || !provider.marketIds.includes(input.marketId)) return null;
  return {
    // 注册表本身就是能力的版本：改注册表要改这个 ID，否则旧 fingerprint 会复用新能力。
    capabilityVersionId: `market-registry-v1-${provider.id}`,
    providerId: provider.id,
    marketId: input.marketId,
    instrumentId: input.instrumentId,
    providerSymbol: input.providerSymbol,
    authorization: provider.authorization,
    usage: [...provider.usage].sort(),
    configured: provider.configured,
    sourceAccountId: null,
  };
}
