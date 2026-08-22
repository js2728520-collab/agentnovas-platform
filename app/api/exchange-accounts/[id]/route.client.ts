import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, exchangeAccounts } from "@/db/schema";
import { EXCHANGE_ADAPTER_STATUS } from "@/lib/exchange-adapters";
import { getExchangeCapability } from "@/lib/exchange-capabilities";
import { ExchangeAdapterError } from "@/lib/exchange-adapters";
import { verifyExchangeAccount } from "@/lib/execution/client";
import { getExchangeOrderRoutingStatus } from "@/lib/exchange-order-routing";
import { requireUser, responseError } from "@/lib/session";

async function owned(id: string, userId: string) {
  return (await getDb().select().from(exchangeAccounts).where(and(eq(exchangeAccounts.id, id), eq(exchangeAccounts.customerId, userId))).limit(1))[0];
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const row = await owned(id, me.id);
    if (!row) return Response.json({ error: "连接不存在" }, { status: 404 });

    const body = await request.json() as { action?: "check" | "disconnect" | "activate" };
    let status = row.status;
    let canRead = row.canRead;
    let canTrade = row.canTrade;
    let message = "状态已更新";
    let permissions: string[] | undefined;
    let canWithdraw: boolean | undefined;
    let accountMode: string | undefined;
    let positionMode: string | undefined;
    let verificationMode: "official" | "local-demo" | undefined;

    if (body.action === "check") {
      try {
        // Web 层不再解密：只传账户 id，拿回的结果里没有任何机密（ADR-0019）。
        // 这也是未来执行服务的接口形状——抽成独立进程时这一行换成跨进程调用即可。
        const result = await verifyExchangeAccount({ accountId: id, customerId: me.id });
        status = "active";
        canRead = result.canRead;
        canTrade = result.canTrade;
        permissions = result.permissions;
        canWithdraw = result.canWithdraw;
        accountMode = result.accountMode;
        positionMode = result.positionMode;
        verificationMode = result.verificationMode;
        const environmentLabel = row.environment === "demo" ? "模拟盘" : "实盘";
        message = result.verificationMode === "local-demo"
          ? `${row.exchange} 模拟盘本地检测通过（未请求交易所真实 API），读取与交易权限按模拟环境处理`
            : result.canTrade
            ? `${row.exchange} ${environmentLabel}官方 API 权限验证通过，读取与交易权限正常`
            : `${row.exchange} 联网验证通过，但未检测到交易权限，暂不能自动跟随`;
      } catch (error) {
        status = "disconnected";
        canRead = false;
        canTrade = false;
        const db = getDb();
        const now = new Date().toISOString();
        await db.batch([
          db.update(exchangeAccounts).set({ status, canRead: false, canTrade: false, lastCheckedAt: now, updatedAt: now }).where(eq(exchangeAccounts.id, id)),
          db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: "exchange_account.check_failed", subjectType: "exchange_account", subjectId: id, afterJson: JSON.stringify({ status, error: error instanceof Error ? error.message : "权限验证失败" }) }),
        ]);
        if (error instanceof ExchangeAdapterError) return Response.json({ error: error.message, status }, { status: error.status });
        throw error;
      }
    } else if (body.action === "disconnect") {
      status = "disconnected";
      canTrade = false;
      message = "连接已断开，系统不会再发送新订单";
    } else if (body.action === "activate" && row.environment === "demo") {
      return Response.json({ error: "模拟盘必须先通过交易所联网权限检测，不能手动跳过" }, { status: 409 });
    } else {
      return Response.json({ error: "不支持的操作" }, { status: 400 });
    }

    const db = getDb();
    const now = new Date().toISOString();
    await db.batch([
      db.update(exchangeAccounts).set({ status, canRead, canTrade, lastCheckedAt: now, updatedAt: now }).where(eq(exchangeAccounts.id, id)),
      db.insert(auditLogs).values({ id: crypto.randomUUID(), actorUserId: me.id, action: `exchange_account.${body.action}`, subjectType: "exchange_account", subjectId: id, afterJson: JSON.stringify({ status, canRead, canTrade, verificationMode, permissions, canWithdraw, accountMode, positionMode }) }),
    ]);

    return Response.json({
      status,
      message,
      canRead,
      canTrade,
      canWithdraw,
      permissions,
      accountMode,
      positionMode,
      verificationMode,
      capabilities: getExchangeCapability(row.exchange) || null,
      adapterStatus: EXCHANGE_ADAPTER_STATUS.find((item) => item.key === row.exchange) || null,
      routing: getExchangeOrderRoutingStatus(row.exchange, row.environment),
    });
  } catch (error) {
    return responseError(error);
  }
}
