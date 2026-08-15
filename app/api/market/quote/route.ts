type Category = "crypto" | "forex" | "metals" | "stocks";
const yahooSymbols: Record<string, string> = { EURUSD: "EURUSD=X", GBPUSD: "GBPUSD=X", USDJPY: "JPY=X", AUDUSD: "AUDUSD=X", USDCAD: "CAD=X", USDCHF: "CHF=X", NZDUSD: "NZDUSD=X", EURJPY: "EURJPY=X", GBPJPY: "GBPJPY=X", XAUUSD: "GC=F", XAGUSD: "SI=F" };
function cryptoProvider(symbol: string) { return `${symbol.replace(/USD$/, "")}USDT`; }
async function yahooQuote(symbol: string) {
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("外部行情源暂时不可用");
  const payload = await response.json() as { chart?: { result?: Array<{ meta?: Record<string, unknown>; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> } }> } };
  const result = payload.chart?.result?.[0]; const meta = result?.meta || {}; const row = result?.indicators?.quote?.[0];
  const closes = (row?.close || []).filter((value): value is number => typeof value === "number"); const price = Number(meta.regularMarketPrice || closes.at(-1) || 0); const previous = Number(meta.chartPreviousClose || meta.previousClose || price);
  const high = Number(meta.regularMarketDayHigh || Math.max(...(row?.high || []).filter((value): value is number => typeof value === "number"), price)); const lowValues = (row?.low || []).filter((value): value is number => typeof value === "number"); const low = Number(meta.regularMarketDayLow || Math.min(...lowValues, price)); const volume = Number(meta.regularMarketVolume || (row?.volume || []).filter((value): value is number => typeof value === "number").at(-1) || 0);
  return { price, change: price - previous, changePercent: previous ? ((price - previous) / previous) * 100 : 0, high, low, volume, open: Number(meta.regularMarketOpen || price), live: price > 0, source: "Yahoo Finance public chart" };
}
export async function GET(request: Request) {
  const url = new URL(request.url); const symbol = (url.searchParams.get("symbol") || "BTCUSD").toUpperCase().replace("/", ""); const category = (url.searchParams.get("category") || "crypto") as Category;
  try {
    if (category === "crypto") { const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${cryptoProvider(symbol)}`, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(5000) }); if (!response.ok) throw new Error("加密货币行情源暂时不可用"); const row = await response.json() as { lastPrice: string; priceChange: string; priceChangePercent: string; highPrice: string; lowPrice: string; volume: string; quoteVolume: string; openPrice: string }; return Response.json({ symbol, price: Number(row.lastPrice), change: Number(row.priceChange), changePercent: Number(row.priceChangePercent), high: Number(row.highPrice), low: Number(row.lowPrice), volume: Number(row.quoteVolume || row.volume), open: Number(row.openPrice), live: true, source: "Binance public market data", updatedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } }); }
    const provider = yahooSymbols[symbol] || symbol; return Response.json({ symbol, ...(await yahooQuote(provider)), updatedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return Response.json({ symbol, price: 0, change: 0, changePercent: 0, high: 0, low: 0, volume: 0, open: 0, live: false, source: "unavailable", updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "行情源暂时不可用" }, { status: 503, headers: { "cache-control": "no-store" } }); }
}
