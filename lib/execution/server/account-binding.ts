/**
 * 交易所账户绑定：加密与落库。
 *
 * 为什么绑定也必须进执行服务：AES-GCM 是对称的，**能加密就能解密**。
 * 只要 Web 进程为了保存凭证而持有那个密钥，「Web 层不能还原客户凭证」这句话就不
 * 成立——解密代码不在构建里没有用，密钥在就够了。
 *
 * 诚实地说清这一步换来了什么：明文凭证仍然会流经 Web 进程，因为它是客户从公网
 * 提交上来的，这无法避免。变化的是**一次一个账户的短暂明文** 与
 * **一把能解开全部账户、长期有效的密钥** 之间的差别。前者被攻破泄露的是攻击窗口
 * 内新绑定的账户，后者泄露的是历史上所有客户的交易权限。
 */

import { getDb } from "../../../db/index.ts";
import { auditLogs, exchangeAccounts } from "../../../db/schema.ts";
import { encryptExchangeCredential, maskedKey } from "../../exchange-credentials.ts";

export type BindExchangeAccountInput = {
  customerId: string;
  exchange: string;
  environment: "demo" | "live";
  label: string;
  apiKey: string;
  secretKey: string;
  passphrase?: string;
  canTrade: boolean;
  now: string;
};

export async function bindExchangeAccount(input: BindExchangeAccountInput): Promise<{ accountId: string }> {
  const id = crypto.randomUUID();
  const encrypted = await encryptExchangeCredential({
    apiKey: input.apiKey,
    secretKey: input.secretKey,
    passphrase: input.passphrase,
  });
  const db = getDb();
  await db.batch([
    db.insert(exchangeAccounts).values({
      id,
      customerId: input.customerId,
      exchange: input.exchange,
      label: input.label,
      environment: input.environment,
      encryptedCredentialRef: encrypted,
      canRead: true,
      canTrade: input.canTrade,
      // INV-11：平台永不持有提现权限。这里恒为 false，且由 migration 0045 的
      // 数据库约束兜底——不依赖任何一层应用代码记得传对。
      withdrawalAuthorized: false,
      status: "pending",
      lastCheckedAt: input.now,
    }),
    db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorUserId: input.customerId,
      action: "exchange_account.created",
      subjectType: "exchange_account",
      subjectId: id,
      afterJson: JSON.stringify({
        exchange: input.exchange,
        environment: input.environment,
        maskedApiKey: maskedKey(input.apiKey),
        canTrade: input.canTrade,
        withdrawalAuthorized: false,
      }),
    }),
  ]);
  return { accountId: id };
}
