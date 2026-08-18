import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { exchangeAccounts } from "@/db/schema";
import { createPerpetualMarketAdapter, type PerpetualExchange } from "@/lib/perpetual-market-adapters";
import { requireResearchUser, ResearchApiError, researchErrorResponse } from "@/lib/research-api";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireResearchUser(request, ["customer"]);
    const { id } = await params;
    const quote = new URL(request.url).searchParams.get("quote")?.toUpperCase() || "USDT";
    if (quote !== "USDT") {
      throw new ResearchApiError("VALIDATION_ERROR", "策略研发仅支持 USDT 永续合约", 422, { fields: ["quote"] });
    }
    const account = (await getDb().select().from(exchangeAccounts).where(and(
      eq(exchangeAccounts.id, id),
      eq(exchangeAccounts.customerId, user.id),
    )).limit(1))[0];
    if (!account) throw new ResearchApiError("NOT_FOUND", "交易所账户不存在", 404);
    if (account.status !== "active" || !account.canRead || account.withdrawalAuthorized) {
      throw new ResearchApiError(
        "INVALID_EXCHANGE_ACCOUNT",
        "交易所账户必须保持激活、只读且不包含提现权限",
        422,
      );
    }
    const exchange = account.exchange.toLowerCase();
    if (!(["okx", "binance", "bybit"] as const).includes(exchange as PerpetualExchange)) {
      throw new ResearchApiError("UNSUPPORTED_EXCHANGE", "仅支持 OKX、Binance 和 Bybit 永续", 422);
    }
    try {
      const instruments = await createPerpetualMarketAdapter(exchange as PerpetualExchange)
        .listInstruments({ quote: "USDT" });
      return Response.json({
        accountId: account.id,
        exchange,
        quote: "USDT",
        instruments,
      }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      throw new ResearchApiError("MARKET_DATA_UNAVAILABLE", "暂时无法读取交易所永续合约目录", 502, {
        exchange,
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  } catch (error) {
    return researchErrorResponse(error);
  }
}
