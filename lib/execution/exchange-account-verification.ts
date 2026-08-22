import { verifyExchangeConnection } from "@/lib/exchange-adapters";

import { loadExchangeCredential } from "./credential-access.ts";

/**
 * 连通性与权限检查。
 *
 * Web 层原本自己解密再调适配器；现在只传账户 id，拿回的结果里**没有任何机密**。
 * 这一层就是未来执行服务的接口形状——抽成独立进程时，把这个函数换成跨进程调用
 * 即可，上层零改动（ADR-0019 第 1 步）。
 */

export type ExchangeAccountVerification = {
  canRead: boolean;
  canTrade: boolean;
  canWithdraw?: boolean;
  permissions?: string[];
  accountMode?: string;
  positionMode?: string;
  verificationMode: "official" | "local-demo";
  exchange: string;
  environment: "demo" | "live";
};

export async function verifyExchangeAccount(input: {
  accountId: string;
  customerId: string;
}): Promise<ExchangeAccountVerification> {
  const resolved = await loadExchangeCredential(input);
  const result = await verifyExchangeConnection({
    exchange: resolved.exchange,
    environment: resolved.environment,
    credentials: resolved.credentials,
  });
  // 只回传非机密字段。凭证不出现在返回值里，调用方无从触碰。
  return {
    canRead: result.canRead,
    canTrade: result.canTrade,
    canWithdraw: result.canWithdraw,
    permissions: result.permissions,
    accountMode: result.accountMode,
    positionMode: result.positionMode,
    verificationMode: result.verificationMode,
    exchange: resolved.exchange,
    environment: resolved.environment,
  };
}
