import {
  getMarketCandles,
  unavailableMarketCandles,
  type MarketCandleCategory,
} from "@/lib/market-candles";

type Category = MarketCandleCategory;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "BTCUSD").toUpperCase().replace("/", "");
  const category = (url.searchParams.get("category") || "crypto") as Category;
  const interval = url.searchParams.get("interval") || "15m";
  const before = Math.max(0, Number(url.searchParams.get("before") || 0));
  const limit = Math.min(1000, Math.max(80, Number(url.searchParams.get("limit") || 160)));
  try {
    return Response.json(await getMarketCandles({ symbol, category, interval, before, limit }), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(unavailableMarketCandles(symbol, interval, error), {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
