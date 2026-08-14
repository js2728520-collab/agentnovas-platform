/**
 * Exchange capability registry shared by the API and the client.
 *
 * This is intentionally conservative: a venue is marked as contract-capable
 * only when the product can route a contract order there.  Regional or
 * account-level availability is still checked by the connector before an
 * account can be activated.
 */
export type ExchangeMarket = "spot" | "contract";

export type ExchangeCapability = {
  key: string;
  displayName: string;
  supportsSpot: boolean;
  supportsContracts: boolean;
  contractNote?: string;
};

export const EXCHANGE_CAPABILITIES: ExchangeCapability[] = [
  { key: "OKX", displayName: "OKX", supportsSpot: true, supportsContracts: true },
  { key: "BINANCE", displayName: "Binance", supportsSpot: true, supportsContracts: true },
  { key: "BYBIT", displayName: "Bybit", supportsSpot: true, supportsContracts: true },
  { key: "BITGET", displayName: "Bitget", supportsSpot: true, supportsContracts: true },
  { key: "GATE.IO", displayName: "Gate.io", supportsSpot: true, supportsContracts: true },
  { key: "KUCOIN", displayName: "KuCoin", supportsSpot: true, supportsContracts: true },
  {
    key: "COINBASE",
    displayName: "Coinbase",
    supportsSpot: true,
    supportsContracts: false,
    contractNote: "Coinbase 账户暂按现货连接处理，不能用于合约策略跟随。",
  },
  {
    key: "KRAKEN",
    displayName: "Kraken",
    supportsSpot: true,
    supportsContracts: false,
    contractNote: "Kraken 账户暂按现货连接处理，不能用于合约策略跟随。",
  },
];

const aliases: Record<string, string> = {
  OKX: "OKX",
  OKEX: "OKX",
  BINANCE: "BINANCE",
  BYBIT: "BYBIT",
  BITGET: "BITGET",
  GATE: "GATE.IO",
  "GATE.IO": "GATE.IO",
  GATEIO: "GATE.IO",
  KUCOIN: "KUCOIN",
  COINBASE: "COINBASE",
  KRAKEN: "KRAKEN",
};

export function normalizeExchange(value: string | undefined | null) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return aliases[normalized] || normalized;
}

export function getExchangeCapability(value: string | undefined | null) {
  const key = normalizeExchange(value);
  return EXCHANGE_CAPABILITIES.find((item) => item.key === key);
}

export function isSupportedExchange(value: string | undefined | null) {
  return Boolean(getExchangeCapability(value));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function text(value: unknown) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function containsContractMarker(value: unknown): boolean {
  if (typeof value === "string") {
    const raw = value.toLowerCase();
    return ["contract", "derivative", "futures", "perpetual", "swap", "永续", "合约", "期货"]
      .some((marker) => raw.includes(marker));
  }
  if (Array.isArray(value)) return value.some(containsContractMarker);
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => {
    const keyText = key.toLowerCase();
    if (["markettype", "instrumenttype", "producttype", "contracttype", "tradingtype", "market"].includes(keyText)) {
      return containsContractMarker(item);
    }
    return containsContractMarker(item);
  });
  return false;
}

/** Detects whether a published strategy requires a derivatives/contract venue. */
export function strategyRequiresContracts(strategy: Record<string, unknown>) {
  const directMarket = text(strategy.market || strategy.marketType || strategy.instrumentType || strategy.productType);
  if (["contract", "contracts", "derivative", "derivatives", "futures", "perpetual", "swap", "合约", "永续"].some((item) => directMarket === item || directMarket.includes(item))) return true;

  const symbols = parseJson(strategy.symbolsJson ?? strategy.symbols);
  if (containsContractMarker(symbols)) return true;
  return containsContractMarker(parseJson(strategy.specificationJson ?? strategy.specification));
}

export function checkExchangeForStrategy(exchange: string, strategy: Record<string, unknown>) {
  const capability = getExchangeCapability(exchange);
  const requiredMarket: ExchangeMarket = strategyRequiresContracts(strategy) ? "contract" : "spot";
  if (!capability) {
    return { ok: false, requiredMarket, capability: null, reason: "该交易所尚未登记在平台适配器中。" };
  }
  if (requiredMarket === "contract" && !capability.supportsContracts) {
    return {
      ok: false,
      requiredMarket,
      capability,
      reason: capability.contractNote || `${capability.displayName} 当前连接不支持合约策略跟随。`,
    };
  }
  if (requiredMarket === "spot" && !capability.supportsSpot) {
    return { ok: false, requiredMarket, capability, reason: `${capability.displayName} 当前不支持现货策略。` };
  }
  return { ok: true, requiredMarket, capability, reason: "" };
}
