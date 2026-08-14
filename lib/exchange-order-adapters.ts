import { getExchangeCapability, normalizeExchange } from "@/lib/exchange-capabilities";
import type { ExchangeEnvironment } from "@/lib/exchange-adapters";

/**
 * Official REST order-contract metadata for each supported venue.
 *
 * This is intentionally a registry, not a live dispatcher. A venue becomes
 * executable only after sandbox tests cover signing, idempotency, cancel,
 * fills and positions. Keeping the contract metadata here lets the UI and
 * audit layer show what is pending without ever sending a live order by
 * accident.
 */
export type ExchangeOrderOperation = "place" | "cancel" | "fills" | "positions";
export type ExchangeOrderAdapter = {
  key: string;
  displayName: string;
  docsUrl: string;
  testnetUrl?: string;
  operations: Record<ExchangeOrderOperation, {
    method: "GET" | "POST" | "DELETE";
    path: string;
    market: "spot" | "contract" | "spot-or-contract";
    idempotency: "client-order-id" | "clientOid" | "text" | "none";
  }>;
  sandboxRequired: true;
  liveEnabled: false;
  note: string;
};

const common = { sandboxRequired: true as const, liveEnabled: false as const };

export const EXCHANGE_ORDER_ADAPTERS: ExchangeOrderAdapter[] = [
  {
    ...common, key: "OKX", displayName: "OKX",
    docsUrl: "https://www.okx.com/docs-v5/en/#rest-api-trade",
    testnetUrl: "https://www.okx.com/docs-v5/en/#overview-demo-trading-services",
    operations: {
      place: { method: "POST", path: "/api/v5/trade/order", market: "spot-or-contract", idempotency: "client-order-id" },
      cancel: { method: "POST", path: "/api/v5/trade/cancel-order", market: "spot-or-contract", idempotency: "client-order-id" },
      fills: { method: "GET", path: "/api/v5/trade/fills", market: "spot-or-contract", idempotency: "none" },
      positions: { method: "GET", path: "/api/v5/account/positions", market: "contract", idempotency: "none" },
    },
    note: "OKX Demo 订单链路已接入，仍需硬风控和显式交易开关。",
  },
  {
    ...common, key: "BINANCE", displayName: "Binance",
    docsUrl: "https://developers.binance.com/docs/binance-spot-api-docs/rest-api/trading-endpoints",
    testnetUrl: "https://testnet.binance.vision/",
    operations: {
      place: { method: "POST", path: "/api/v3/order", market: "spot", idempotency: "client-order-id" },
      cancel: { method: "DELETE", path: "/api/v3/order", market: "spot", idempotency: "client-order-id" },
      fills: { method: "GET", path: "/api/v3/myTrades", market: "spot", idempotency: "none" },
      positions: { method: "GET", path: "/fapi/v2/positionRisk", market: "contract", idempotency: "none" },
    },
    note: "现货与 USDⓈ-M 合约使用不同官方 API 域和签名参数，需分别完成沙盒验证。",
  },
  {
    ...common, key: "BYBIT", displayName: "Bybit",
    docsUrl: "https://bybit-exchange.github.io/docs/v5/order/create-order",
    testnetUrl: "https://testnet.bybit.com/",
    operations: {
      place: { method: "POST", path: "/v5/order/create", market: "spot-or-contract", idempotency: "client-order-id" },
      cancel: { method: "POST", path: "/v5/order/cancel", market: "spot-or-contract", idempotency: "client-order-id" },
      fills: { method: "GET", path: "/v5/execution/list", market: "spot-or-contract", idempotency: "none" },
      positions: { method: "GET", path: "/v5/position/list", market: "contract", idempotency: "none" },
    },
    note: "统一账户的 spot、linear、inverse 参数需要按策略市场类型映射。",
  },
  {
    ...common, key: "BITGET", displayName: "Bitget",
    docsUrl: "https://www.bitget.com/api-doc/contract/trade/Place-Order",
    testnetUrl: "https://www.bitget.com/api-doc/common/demo",
    operations: {
      place: { method: "POST", path: "/api/v2/spot/trade/place-order", market: "spot-or-contract", idempotency: "clientOid" },
      cancel: { method: "POST", path: "/api/v2/spot/trade/cancel-order", market: "spot-or-contract", idempotency: "clientOid" },
      fills: { method: "GET", path: "/api/v2/spot/trade/fills", market: "spot-or-contract", idempotency: "none" },
      positions: { method: "GET", path: "/api/v2/mix/position/all-position", market: "contract", idempotency: "none" },
    },
    note: "现货与 Mix 合约使用不同 productType；沙盒需验证 paptrading 与签名组合。",
  },
  {
    ...common, key: "GATE.IO", displayName: "Gate.io",
    docsUrl: "https://www.gate.io/docs/developers/apiv4/en/#create-an-order",
    operations: {
      place: { method: "POST", path: "/api/v4/spot/orders", market: "spot-or-contract", idempotency: "text" },
      cancel: { method: "DELETE", path: "/api/v4/spot/orders/{order_id}", market: "spot-or-contract", idempotency: "none" },
      fills: { method: "GET", path: "/api/v4/spot/my_trades", market: "spot-or-contract", idempotency: "none" },
      positions: { method: "GET", path: "/api/v4/futures/{settle}/positions", market: "contract", idempotency: "none" },
    },
    note: "Gate.io 合约路径包含结算币种 settle，不能与现货订单路径混用。",
  },
  {
    ...common, key: "KUCOIN", displayName: "KuCoin",
    docsUrl: "https://www.kucoin.com/docs-new/rest/spot-trading/orders/add-order",
    testnetUrl: "https://www.kucoin.com/docs-new/api-3470175",
    operations: {
      place: { method: "POST", path: "/api/v1/orders", market: "spot-or-contract", idempotency: "clientOid" },
      cancel: { method: "DELETE", path: "/api/v1/orders/{orderId}", market: "spot-or-contract", idempotency: "none" },
      fills: { method: "GET", path: "/api/v1/fills", market: "spot-or-contract", idempotency: "none" },
      positions: { method: "GET", path: "/api/v1/position", market: "contract", idempotency: "none" },
    },
    note: "KuCoin Sandbox 与 Futures API 的账户和签名参数需要分开验证。",
  },
  {
    ...common, key: "COINBASE", displayName: "Coinbase",
    docsUrl: "https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/create-order",
    testnetUrl: "https://docs.cdp.coinbase.com/advanced-trade/docs/sandbox",
    operations: {
      place: { method: "POST", path: "/api/v3/brokerage/orders", market: "spot", idempotency: "client-order-id" },
      cancel: { method: "POST", path: "/api/v3/brokerage/orders/batch_cancel", market: "spot", idempotency: "client-order-id" },
      fills: { method: "GET", path: "/api/v3/brokerage/orders/historical/fills", market: "spot", idempotency: "none" },
      positions: { method: "GET", path: "/api/v3/brokerage/accounts", market: "spot", idempotency: "none" },
    },
    note: "当前按 Coinbase Advanced Trade 现货连接处理，不支持合约策略跟随。",
  },
  {
    ...common, key: "KRAKEN", displayName: "Kraken",
    docsUrl: "https://docs.kraken.com/api/docs/rest-api/add-order",
    operations: {
      place: { method: "POST", path: "/0/private/AddOrder", market: "spot", idempotency: "none" },
      cancel: { method: "POST", path: "/0/private/CancelOrder", market: "spot", idempotency: "none" },
      fills: { method: "POST", path: "/0/private/TradesHistory", market: "spot", idempotency: "none" },
      positions: { method: "POST", path: "/0/private/Balance", market: "spot", idempotency: "none" },
    },
    note: "当前按 Kraken 现货连接处理，不支持合约策略跟随。",
  },
];

export function getExchangeOrderAdapter(exchange: string | undefined | null) {
  const key = normalizeExchange(exchange);
  return EXCHANGE_ORDER_ADAPTERS.find((adapter) => adapter.key === key) || null;
}

export function getExchangeOrderAdapterSummary(exchange: string | undefined | null, environment: ExchangeEnvironment) {
  const adapter = getExchangeOrderAdapter(exchange);
  const capability = getExchangeCapability(exchange);
  if (!adapter || !capability) return null;
  return {
    key: adapter.key,
    displayName: adapter.displayName,
    environment,
    docsUrl: adapter.docsUrl,
    testnetUrl: adapter.testnetUrl || null,
    operations: adapter.operations,
    supportsSpot: capability.supportsSpot,
    supportsContracts: capability.supportsContracts,
    sandboxRequired: adapter.sandboxRequired,
    liveEnabled: adapter.liveEnabled,
    note: adapter.note,
  };
}
