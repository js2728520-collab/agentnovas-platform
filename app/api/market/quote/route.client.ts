import { getMarketQuote, unavailableMarketQuote, type MarketQuoteCategory } from "@/lib/market-quotes";

type Category = MarketQuoteCategory;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "BTCUSD").toUpperCase().replace("/", "");
  const category = (url.searchParams.get("category") || "crypto") as Category;
  try {
    return Response.json(await getMarketQuote(symbol, category), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(unavailableMarketQuote(symbol, error), {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
