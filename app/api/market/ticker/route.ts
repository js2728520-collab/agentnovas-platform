
import { fetchPublicMarketJson, publicMarketProviderName } from "@/lib/public-market-source";

const symbols=[
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","LTCUSDT","LINKUSDT","AVAXUSDT",
  "TONUSDT","TRXUSDT","DOTUSDT","NEARUSDT","ARBUSDT","OPUSDT","ATOMUSDT","UNIUSDT","BCHUSDT","SUIUSDT",
  "APTUSDT","FILUSDT","ICPUSDT","ETCUSDT","XLMUSDT","HBARUSDT","VETUSDT","ALGOUSDT","AAVEUSDT","MKRUSDT",
  "CRVUSDT","SANDUSDT","MANAUSDT","PEPEUSDT","SHIBUSDT","WIFUSDT","BONKUSDT","SEIUSDT","INJUSDT","TIAUSDT",
  "RUNEUSDT","LDOUSDT","IMXUSDT","GRTUSDT","EGLDUSDT","KASUSDT","STXUSDT","THETAUSDT","JASMYUSDT","XMRUSDT",
  "ZECUSDT","CROUSDT","FTMUSDT",
];
export async function GET(){try{
  // Fetch the public 24h universe once, then keep only the products shown in
  // the market center. This avoids one invalid/temporarily delisted symbol
  // taking down the complete live feed.
  const path=process.env.MARKET_DATA_TICKER_PATH||"/api/v3/ticker/24hr";
  const {data:rows,base}=await fetchPublicMarketJson<Array<{symbol:string,lastPrice:string,priceChangePercent:string,quoteVolume:string,highPrice:string,lowPrice:string}>>(path,4500);
  const wanted=new Set(symbols);
  const items=rows.filter(x=>wanted.has(x.symbol)).map(x=>({symbol:x.symbol.replace("USDT",""),price:Number(x.lastPrice),change24h:Number(x.priceChangePercent),volume24h:Number(x.quoteVolume),high24h:Number(x.highPrice),low24h:Number(x.lowPrice)}));
  return Response.json({source:process.env.MARKET_DATA_PROVIDER||publicMarketProviderName(base),live:items.length>0,updatedAt:new Date().toISOString(),latencyMs:null,items});
}catch(e){return Response.json({source:"unavailable",live:false,updatedAt:new Date().toISOString(),latencyMs:null,items:[],error:e instanceof Error?e.message:"行情源暂时不可用"},{status:503})}}
