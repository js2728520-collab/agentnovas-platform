import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { exchangeAccounts } from "@/db/schema";
import { EXCHANGE_ADAPTER_STATUS } from "@/lib/exchange-adapters";
import { getExchangeCapability } from "@/lib/exchange-capabilities";
import { getExchangeOrderRoutingStatus } from "@/lib/exchange-order-routing";
import { requireUser, responseError } from "@/lib/session";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireUser(request, ["customer"]);
    const { id } = await params;
    const account = (await getDb().select().from(exchangeAccounts).where(and(
      eq(exchangeAccounts.id, id),
      eq(exchangeAccounts.customerId, me.id),
    )).limit(1))[0];
    if (!account) return Response.json({ error: "连接不存在" }, { status: 404 });

    const routing = getExchangeOrderRoutingStatus(account.exchange, account.environment);
    return Response.json({
      exchange: account.exchange,
      environment: account.environment,
      status: account.status,
      canRead: account.canRead,
      canTrade: account.canTrade,
      capabilities: getExchangeCapability(account.exchange) || null,
      adapterStatus: EXCHANGE_ADAPTER_STATUS.find((item) => item.key === account.exchange) || null,
      routing,
    });
  } catch (error) {
    return responseError(error);
  }
}
