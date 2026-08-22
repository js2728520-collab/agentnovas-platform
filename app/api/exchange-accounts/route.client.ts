import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { exchangeAccounts } from "@/db/schema";
import {
  EXCHANGE_CAPABILITIES,
  getExchangeCapability,
  isSupportedExchange,
  normalizeExchange,
} from "@/lib/exchange-capabilities";
import { EXCHANGE_ADAPTER_STATUS } from "@/lib/exchange-adapters";
import { bindExchangeAccount, ExecutionServiceError } from "@/lib/execution/client";
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
    const walletConnection = exchange === "METAMASK";
    if (!body.apiKey?.trim() || (!walletConnection && !body.secretKey?.trim())) {
      return Response.json({ error: walletConnection ? "请填写钱包地址" : "API Key 和 Secret Key 为必填" }, { status: 400 });
    }
    if (["OKX", "BITGET", "KUCOIN"].includes(exchange) && !body.passphrase?.trim()) {
      return Response.json({ error: `${capability.displayName} 连接必须填写 Passphrase` }, { status: 400 });
    }
    if (!body.canRead) {
      return Response.json({ error: "必须开启账户读取权限" }, { status: 400 });
    }
    // 平台永不持有提现权限：带提现授权的凭证一律拒绝录入。绩效分成从预充服务
    // 余额扣除，不需要也不允许从客户交易所账户直接划走。数据库还有约束兜底。
    if (body.withdrawalAuthorized) {
      return Response.json({
        code: "WITHDRAWAL_AUTHORITY_FORBIDDEN",
        error: "平台不接收带提现权限的凭证。请在交易所只勾选读取与交易权限，并限制 IP。",
      }, { status: 400 });
    }
    const environment = body.environment || "demo";
    if (environment === "live" && !adapter?.permissionCheckReady) {
      return Response.json({
        code: "EXCHANGE_ADAPTER_NOT_READY",
        error: `${capability.displayName} 的真实权限检测适配器尚未接入，当前只能登记模拟盘连接`,
        adapterStatus: adapter || null,
      }, { status: 409 });
    }

    // 加密与落库都在执行服务里完成：Web 层不持有凭证加密密钥。
    // 对称加密下「能加密就能解密」，把加密留在这里等于把密钥留在这里（ADR-0019）。
    let accountId: string;
    try {
      ({ accountId } = await bindExchangeAccount({
        customerId: me.id,
        exchange,
        environment,
        label: body.label?.trim() || `${capability.displayName} ${environment === "live" ? "实盘" : "模拟盘"}`,
        apiKey: body.apiKey.trim(),
        secretKey: walletConnection ? "wallet-connection" : body.secretKey!.trim(),
        passphrase: body.passphrase?.trim(),
        canTrade: Boolean(body.canTrade),
        now: new Date().toISOString(),
      }));
    } catch (error) {
      // 服务不可用要说「暂时无法保存」，不能说「凭证无效」——后者会让客户去交易所
      // 重新生成一把没有问题的密钥（INV-6）。
      if (error instanceof ExecutionServiceError && error.isUnavailable) {
        return Response.json({
          code: "EXECUTION_SERVICE_UNAVAILABLE",
          error: "凭证保存服务当前不可用，凭证未被保存，请稍后重试",
        }, { status: 503 });
      }
      throw error;
    }

    return Response.json({
      id: accountId,
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
