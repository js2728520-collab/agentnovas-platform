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
  instrumentPrefix: string;
}> = {
  crypto: {
    marketId: "crypto-global",
    assetClass: "crypto",
    providerId: "public-binance-market-data",
    instrumentPrefix: "crypto",
  },
  forex: {
    marketId: "forex-global",
    assetClass: "forex",
    providerId: "public-yahoo-market-data",
    instrumentPrefix: "forex",
  },
  metals: {
    marketId: "metals-global",
    assetClass: "metal",
    providerId: "public-yahoo-market-data",
    instrumentPrefix: "metal",
  },
  stocks: {
    marketId: "equities-us",
    assetClass: "equity",
    providerId: "public-yahoo-market-data",
    instrumentPrefix: "equity-us",
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

function instrumentIdentity(instrument: MarketInstrument, prefix: string) {
  const parts = instrument.label.split("/").map((part) => part.toLowerCase());
  return parts.length === 2
    ? { id: `${prefix}-${parts[0]}-${parts[1]}`, quoteCurrency: parts[1].toUpperCase() }
    : { id: `${prefix}-${instrument.symbol.toLowerCase()}`, quoteCurrency: "USD" };
}

export const marketCatalogInstruments: MarketCatalogInstrument[] = marketInstruments.map((instrument) => {
  const contract = categoryContract[instrument.category];
  const identity = instrumentIdentity(instrument, contract.instrumentPrefix);
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
