import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { exchangeAccounts } from "@/db/schema";
import { decryptExchangeCredential, type ExchangeCredential } from "@/lib/exchange-credentials";

/**
 * 交易所凭证的唯一解密点。
 *
 * **本模块只允许被 `lib/execution/**` 引用**，由架构边界规则强制。
 *
 * 背景（ADR-0019）：凭证是 AES-GCM 密文内联存在
 * `exchange_accounts.encrypted_credential_ref`，密钥来自环境变量
 * `EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`。任何同时拥有该环境变量与数据库读权限的
 * 进程都能解密全部客户的交易凭证。此前公网面向客户的 Web 进程正是这样一个进程
 * ——`exchange-accounts/[id]` 的 check 动作直接解密。Beta 只跑 paper 时风险被限制
 * 在「凭证泄露但平台不下单」，GA 打开实盘后，公网盒子被攻破一次 = 全部客户的
 * 交易权限被拿走。
 *
 * 这里把解密收敛到一个模块，是把它抽成独立执行服务进程的前置步骤：
 * 调用形状先定下来（只传 id、只拿回非机密结果），之后换成跨进程调用时
 * 上层零改动。
 */

export type ResolvedExchangeCredential = {
  accountId: string;
  exchange: string;
  environment: "demo" | "live";
  credentials: ExchangeCredential;
};

/**
 * 按账户 id 取出可用凭证。
 *
 * 校验在这里做而不是交给调用方：调用方拿不到凭证，也就无从「先取再判断」。
 * 提现权限一票否决——INV-11 要求平台永不持有提现权限，数据库约束已经挡了写入，
 * 这里是读取侧的第二道。
 */
export async function loadExchangeCredential(input: {
  accountId: string;
  customerId: string;
}): Promise<ResolvedExchangeCredential> {
  const row = (await getDb()
    .select()
    .from(exchangeAccounts)
    .where(and(eq(exchangeAccounts.id, input.accountId), eq(exchangeAccounts.customerId, input.customerId)))
    .limit(1))[0];
  if (!row) throw new Error("EXCHANGE_ACCOUNT_NOT_FOUND");
  if (row.withdrawalAuthorized) throw new Error("EXCHANGE_ACCOUNT_HAS_WITHDRAWAL_AUTHORITY");
  return {
    accountId: row.id,
    exchange: row.exchange,
    environment: row.environment as "demo" | "live",
    credentials: await decryptExchangeCredential(row.encryptedCredentialRef),
  };
}
