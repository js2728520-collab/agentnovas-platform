import {
  MARKET_DATA_CONTRACT_VERSION,
  normalizeMarketDescriptor,
  type MarketAssetClass,
  type MarketDescriptor,
} from "../packages/contracts/src/market-data.ts";
import { marketInstruments, type MarketCategory, type MarketInstrument } from "./market-instruments.ts";

type ProviderSymbolMapping = {
  providerId: string;
  providerSymbol: string;
};

export type MarketCatalogInstrument = MarketInstrument & {
  id: string;
  marketId: string;
  assetClass: MarketAssetClass;
  quoteCurrency: string;
  providerMappings: ProviderSymbolMapping[];
};

const categoryContract: Record<MarketCategory, {
  marketId: string;
  assetClass: MarketAssetClass;
  providerId: string;
}> = {
  crypto: {
    marketId: "crypto-global",
    assetClass: "crypto",
    providerId: "public-binance-market-data",
  },
  forex: {
    marketId: "forex-global",
    assetClass: "forex",
    providerId: "public-yahoo-market-data",
  },
  metals: {
    marketId: "metals-global",
    assetClass: "metal",
    providerId: "public-yahoo-market-data",
  },
  stocks: {
    marketId: "equities-us",
    assetClass: "equity",
    providerId: "public-yahoo-market-data",
  },
};

export const marketCatalog: MarketDescriptor[] = [
  normalizeMarketDescriptor({
    id: "crypto-global",
    assetClass: "crypto",
    region: "global",
    timezone: "UTC",
    calendar: { id: "crypto-24-7", kind: "continuous" },
    capabilities: ["instrument_search", "quote_snapshot", "candle_history"],
    protocols: ["rest"],
    usage: ["display", "research"],
    executionPolicy: "display_only",
  }),
  normalizeMarketDescriptor({
    id: "equities-us",
    assetClass: "equity",
    region: "us",
    timezone: "America/New_York",
    calendar: { id: "us-equities-provider-calendar", kind: "provider_managed" },
    capabilities: ["instrument_search", "quote_snapshot", "candle_history"],
    protocols: ["rest"],
    usage: ["display", "research"],
    executionPolicy: "display_only",
  }),
  normalizeMarketDescriptor({
    id: "forex-global",
    assetClass: "forex",
    region: "global",
    timezone: "UTC",
    calendar: { id: "forex-provider-calendar", kind: "provider_managed" },
    capabilities: ["instrument_search", "quote_snapshot", "candle_history"],
    protocols: ["rest"],
    usage: ["display", "research"],
    executionPolicy: "display_only",
  }),
  normalizeMarketDescriptor({
    id: "metals-global",
    assetClass: "metal",
    region: "global",
    timezone: "UTC",
    calendar: { id: "metals-provider-calendar", kind: "provider_managed" },
    capabilities: ["instrument_search", "quote_snapshot", "candle_history"],
    protocols: ["rest"],
    usage: ["display", "research"],
    executionPolicy: "display_only",
  }),
];

const instrumentContractRows = [
  ["BTCUSD", "crypto-btc-usd", "USD"],
  ["ETHUSD", "crypto-eth-usd", "USD"],
  ["SOLUSD", "crypto-sol-usd", "USD"],
  ["XRPUSD", "crypto-xrp-usd", "USD"],
  ["DOGEUSD", "crypto-doge-usd", "USD"],
  ["BNBUSD", "crypto-bnb-usd", "USD"],
  ["ADAUSD", "crypto-ada-usd", "USD"],
  ["LTCUSD", "crypto-ltc-usd", "USD"],
  ["LINKUSD", "crypto-link-usd", "USD"],
  ["AVAXUSD", "crypto-avax-usd", "USD"],
  ["TONUSD", "crypto-ton-usd", "USD"],
  ["TRXUSD", "crypto-trx-usd", "USD"],
  ["DOTUSD", "crypto-dot-usd", "USD"],
  ["BCHUSD", "crypto-bch-usd", "USD"],
  ["SUIUSD", "crypto-sui-usd", "USD"],
  ["APTUSD", "crypto-apt-usd", "USD"],
  ["NEARUSD", "crypto-near-usd", "USD"],
  ["ARBUSD", "crypto-arb-usd", "USD"],
  ["OPUSD", "crypto-op-usd", "USD"],
  ["UNIUSD", "crypto-uni-usd", "USD"],
  ["EURUSD", "forex-eur-usd", "USD"],
  ["GBPUSD", "forex-gbp-usd", "USD"],
  ["USDJPY", "forex-usd-jpy", "JPY"],
  ["AUDUSD", "forex-aud-usd", "USD"],
  ["USDCAD", "forex-usd-cad", "CAD"],
  ["USDCHF", "forex-usd-chf", "CHF"],
  ["NZDUSD", "forex-nzd-usd", "USD"],
  ["EURJPY", "forex-eur-jpy", "JPY"],
  ["GBPJPY", "forex-gbp-jpy", "JPY"],
  ["XAUUSD", "metal-xau-usd", "USD"],
  ["XAGUSD", "metal-xag-usd", "USD"],
  ["AAPL", "equity-us-aapl", "USD"],
  ["TSLA", "equity-us-tsla", "USD"],
  ["NVDA", "equity-us-nvda", "USD"],
  ["MSFT", "equity-us-msft", "USD"],
  ["AMZN", "equity-us-amzn", "USD"],
  ["META", "equity-us-meta", "USD"],
  ["GOOGL", "equity-us-googl", "USD"],
  ["AMD", "equity-us-amd", "USD"],
  ["NFLX", "equity-us-nflx", "USD"],
] as const;

const instrumentContracts = new Map<string, { id: string; quoteCurrency: string }>(
  instrumentContractRows.map(([symbol, id, quoteCurrency]) => [symbol, { id, quoteCurrency }]),
);
if (instrumentContracts.size !== instrumentContractRows.length || instrumentContracts.size !== marketInstruments.length) {
  throw new Error("Market catalog has a missing explicit contract or duplicate instrument contract");
}

export const marketCatalogInstruments: MarketCatalogInstrument[] = marketInstruments.map((instrument) => {
  const contract = categoryContract[instrument.category];
  const identity = instrumentContracts.get(instrument.symbol);
  if (!identity) throw new Error(`Missing explicit contract for market instrument ${instrument.symbol}`);
  return {
    ...instrument,
    ...identity,
    marketId: contract.marketId,
    assetClass: contract.assetClass,
    providerMappings: [{ providerId: contract.providerId, providerSymbol: instrument.providerSymbol }],
  };
});

export function createMarketInstrumentsPayload(updatedAt: string) {
  if (typeof updatedAt !== "string" || updatedAt.length > 40 || !updatedAt.endsWith("Z")) {
    throw new Error("updatedAt must be a bounded ISO UTC timestamp");
  }
  const parsedUpdatedAt = Date.parse(updatedAt);
  if (!Number.isFinite(parsedUpdatedAt)) throw new Error("updatedAt must be a bounded ISO UTC timestamp");
  return {
    contractVersion: MARKET_DATA_CONTRACT_VERSION,
    markets: marketCatalog,
    instruments: marketCatalogInstruments,
    updatedAt: new Date(parsedUpdatedAt).toISOString(),
    source: "Riverton Capital market catalog",
  };
}
