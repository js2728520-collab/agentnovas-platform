import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, exchangeAccounts } from "@/db/schema";
import {
  EXCHANGE_CAPABILITIES,
  getExchangeCapability,
  isSupportedExchange,
  normalizeExchange,
} from "@/lib/exchange-capabilities";
import { EXCHANGE_ADAPTER_STATUS } from "@/lib/exchange-adapters";
import { encryptExchangeCredential, maskedKey } from "@/lib/exchange-credentials";
import { getExchangeOrderAdapterSummary } from "@/lib/exchange-order-adapters";
import { getExchangeOrderRoutingStatus } from "@/lib/exchange-order-routing";
import { requireUser, responseError } from "@/lib/session";

export async function GET(request: Request) {
  try {
    const me = await requireUser(request, ["customer"]);
    const rows = await getDb()
      .select()
      .from(exchangeAccounts)
      .where(eq(exchangeAccounts.customerId, me.id))
      .orderBy(desc(exchangeAccounts.updatedAt));

    return Response.json({
      supportedExchanges: EXCHANGE_CAPABILITIES,
      adapterStatus: EXCHANGE_ADAPTER_STATUS,
      accounts: rows.map(({ encryptedCredentialRef, withdrawalCredentialRef, ...account }) => ({
        ...account,
        capabilities: getExchangeCapability(account.exchange) || null,
        orderAdapter: getExchangeOrderAdapterSummary(account.exchange, account.environment),
        routing: getExchangeOrderRoutingStatus(account.exchange, account.environment),
        credentialConfigured: Boolean(encryptedCredentialRef),
        withdrawalCredentialConfigured: Boolean(withdrawalCredentialRef),
      })),
    });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const me = await requireUser(request, ["customer"]);
    if (!me.emailVerifiedAt) {
      return Response.json({ error: "请先完成邮箱验证，再连接交易所" }, { status: 403 });
    }

    const body = await request.json() as {
      exchange?: string;
      label?: string;
      environment?: "demo" | "live";
      apiKey?: string;
      secretKey?: string;
      passphrase?: string;
      canRead?: boolean;
      canTrade?: boolean;
      withdrawalAuthorized?: boolean;
    };
    const exchange = normalizeExchange(body.exchange);
    const capability = getExchangeCapability(exchange);
    const adapter = EXCHANGE_ADAPTER_STATUS.find((item) => item.key === exchange);
    if (!capability || !isSupportedExchange(exchange)) {
      return Response.json({ error: "暂不支持该交易所", supportedExchanges: EXCHANGE_CAPABILITIES }, { status: 400 });
    }
    if (!body.apiKey?.trim() || !body.secretKey?.trim()) {
      return Response.json({ error: "API Key 和 Secret Key 为必填" }, { status: 400 });
    }
    if (["OKX", "BITGET", "KUCOIN"].includes(exchange) && !body.passphrase?.trim()) {
      return Response.json({ error: `${capability.displayName} 连接必须填写 Passphrase` }, { status: 400 });
    }
    if (!body.canRead) {
      return Response.json({ error: "必须开启账户读取权限" }, { status: 400 });
    }
    const environment = body.environment || "demo";
    if (environment === "live" && !adapter?.permissionCheckReady) {
      return Response.json({
        code: "EXCHANGE_ADAPTER_NOT_READY",
        error: `${capability.displayName} 的真实权限检测适配器尚未接入，当前只能登记模拟盘连接`,
        adapterStatus: adapter || null,
      }, { status: 409 });
    }

    const db = getDb();
    const id = crypto.randomUUID();
    const encrypted = await encryptExchangeCredential({
      apiKey: body.apiKey.trim(),
      secretKey: body.secretKey.trim(),
      passphrase: body.passphrase?.trim(),
    });
    await db.batch([
      db.insert(exchangeAccounts).values({
        id,
        customerId: me.id,
        exchange,
        label: body.label?.trim() || `${capability.displayName} ${environment === "live" ? "实盘" : "模拟盘"}`,
        environment,
        encryptedCredentialRef: encrypted,
        canRead: true,
        canTrade: Boolean(body.canTrade),
        withdrawalAuthorized: Boolean(body.withdrawalAuthorized),
        status: "pending",
        lastCheckedAt: new Date().toISOString(),
      }),
      db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorUserId: me.id,
        action: "exchange_account.created",
        subjectType: "exchange_account",
        subjectId: id,
        afterJson: JSON.stringify({
          exchange,
          environment,
          maskedApiKey: maskedKey(body.apiKey.trim()),
          canTrade: Boolean(body.canTrade),
          withdrawalAuthorized: Boolean(body.withdrawalAuthorized),
        }),
      }),
    ]);

    return Response.json({
      id,
      status: "pending",
      capabilities: capability,
      adapterStatus: EXCHANGE_ADAPTER_STATUS.find((item) => item.key === exchange) || null,
      orderAdapter: getExchangeOrderAdapterSummary(exchange, environment),
      routing: getExchangeOrderRoutingStatus(exchange, environment),
      message: "凭证已加密保存，等待该交易所权限检测",
    }, { status: 201 });
  } catch (error) {
    return responseError(error);
  }
}
