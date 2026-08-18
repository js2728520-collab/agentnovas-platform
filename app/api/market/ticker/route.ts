
import { getPublicMarketQuote } from "@/lib/market-sources";
import { resolveMarketSource } from "@/lib/market-source-selection";

const symbols=[
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","LTCUSDT","LINKUSDT","AVAXUSDT",
  "TONUSDT","TRXUSDT","DOTUSDT","NEARUSDT","ARBUSDT","OPUSDT","ATOMUSDT","UNIUSDT","BCHUSDT","SUIUSDT",
  "APTUSDT","FILUSDT","ICPUSDT","ETCUSDT","XLMUSDT","HBARUSDT","VETUSDT","ALGOUSDT","AAVEUSDT","MKRUSDT",
  "CRVUSDT","SANDUSDT","MANAUSDT","PEPEUSDT","SHIBUSDT","WIFUSDT","BONKUSDT","SEIUSDT","INJUSDT","TIAUSDT",
  "RUNEUSDT","LDOUSDT","IMXUSDT","GRTUSDT","EGLDUSDT","KASUSDT","STXUSDT","THETAUSDT","JASMYUSDT","XMRUSDT",
  "ZECUSDT","CROUSDT","FTMUSDT",
];
export async function GET(request: Request){
  const selection = await resolveMarketSource(request, new URL(request.url).searchParams.get("exchange"));
  try {
    const items: Array<{symbol:string;price:number;change24h:number;volume24h:number;high24h:number;low24h:number}> = [];
    for (let index = 0; index < symbols.length; index += 8) {
      const batch = await Promise.allSettled(symbols.slice(index, index + 8).map(async (providerSymbol) => {
        const quote = await getPublicMarketQuote(selection.source, providerSymbol.replace(/USDT$/, "USD"));
        return { symbol: providerSymbol.replace("USDT", ""), price: quote.price, change24h: quote.changePercent, volume24h: quote.volume, high24h: quote.high, low24h: quote.low };
      }));
      batch.forEach((result) => { if (result.status === "fulfilled") items.push(result.value); });
    }
    return Response.json({source: selection.source.displayName, exchange: selection.source.key, selectionMode: selection.mode, live: items.length > 0, updatedAt: new Date().toISOString(), latencyMs:null, items});
  } catch(e) { return Response.json({source:"unavailable",exchange:selection.source.key,selectionMode:selection.mode,live:false,updatedAt:new Date().toISOString(),latencyMs:null,items:[],error:e instanceof Error?e.message:"行情源暂时不可用"},{status:503}); }
}
