import { INTEGRATION_CATALOG } from "./integration-catalog.ts";
import {
  registeredEquityProviders,
  registeredExchangeProviders,
} from "../packages/contracts/src/market-provider-registry.ts";

/**
 * 行情 provider 的真实配置状态（T4.4 配置入口）。
 *
 * 注册表里 `configured` 恒为 `false`——那是刻意的默认：凭证与授权是**部署事实**，写死 true
 * 等于宣称一个从未验证过的连接可用。真实状态由环境变量决定，而环境变量正是配置入口本身：
 * 运维在部署里设上 key，这里就变 true，运维端界面随之显示已配置。
 *
 * 判定只看「key 在不在」，**不代表连接可用**。可用与否要靠运维端的连通性检查
 * （`runMaintenanceSourceIntegrationCheck`），两者不能混为一谈（INV-6：未配置不得伪装就绪，
 * 已配置也不等于已验证）。
 */

export type MarketProviderStatus = {
  providerId: string;
  name: string;
  marketIds: readonly string[];
  /** 环境里是否已提供全部所需凭证。 */
  configured: boolean;
  /** 需要哪些环境变量。界面照这个告诉运维要配什么。 */
  envKeys: readonly string[];
  /** 缺哪几个。全部齐了才算 configured——缺一个就是没配好，不是配了一半。 */
  missingEnvKeys: readonly string[];
};

function statusFor(
  providerId: string,
  name: string,
  marketIds: readonly string[],
  environment: Record<string, string | undefined>,
): MarketProviderStatus {
  const definition = INTEGRATION_CATALOG.find((item) => item.id === providerId);
  const envKeys = definition?.envKeys ?? [];
  const missingEnvKeys = envKeys.filter((key) => !environment[key]?.trim());
  return {
    providerId,
    name,
    marketIds,
    // 目录里没有这个 provider 时一律未配置——一个没登记配置入口的 provider 不可能被配好。
    configured: Boolean(definition) && envKeys.length > 0 && missingEnvKeys.length === 0,
    envKeys,
    missingEnvKeys,
  };
}

export function marketProviderStatuses(
  environment: Record<string, string | undefined> = process.env,
): MarketProviderStatus[] {
  return [
    ...registeredExchangeProviders().map((provider) =>
      statusFor(provider.id, provider.name, provider.marketIds, environment)),
    ...registeredEquityProviders().map((provider) =>
      statusFor(provider.id, provider.name, provider.marketIds, environment)),
  ];
}

/** 某个 provider 此刻是否可用于取数。运行时消费者用它，不要读注册表里的 `configured`。 */
export function isMarketProviderConfigured(
  providerId: string,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return marketProviderStatuses(environment).find((entry) => entry.providerId === providerId)?.configured ?? false;
}
