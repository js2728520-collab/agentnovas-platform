import { createHash, createHmac } from "node:crypto";

import type { OfficialTradingHallStrategy } from "../packages/contracts/src/trading-hall.ts";

export type PlatformDemoProvider = "okx" | "binance" | "bybit";
type StrategyCode = OfficialTradingHallStrategy["code"];
type SpotSymbol = "BTCUSDT" | "ETHUSDT" | "SOLUSDT";

export const PLATFORM_DEMO_ENDPOINTS = Object.freeze({
  okx: "https://openapi.okx.com",
  binance: "https://testnet.binance.vision",
  bybit: "https://api-demo.bybit.com",
}) satisfies Readonly<Record<PlatformDemoProvider, string>>;

export type PlatformDemoTransportRequest = {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
};

export type PlatformDemoTransport = {
  request(input: PlatformDemoTransportRequest): Promise<{ status: number; json: unknown }>;
};

const PLATFORM_DEMO_ALLOWED_ROUTES = Object.freeze({
  okx: new Set([
    "GET /api/v5/account/balance",
    "POST /api/v5/trade/order",
    "GET /api/v5/trade/order",
    "POST /api/v5/trade/cancel-order",
    "GET /api/v5/trade/fills",
  ]),
  binance: new Set([
    "GET /api/v3/account",
    "POST /api/v3/order",
    "GET /api/v3/order",
    "DELETE /api/v3/order",
    "GET /api/v3/myTrades",
  ]),
  bybit: new Set([
    "GET /v5/account/wallet-balance",
    "POST /v5/order/create",
    "GET /v5/order/realtime",
    "POST /v5/order/cancel",
    "GET /v5/execution/list",
  ]),
}) satisfies Readonly<Record<PlatformDemoProvider, ReadonlySet<string>>>;

function transportBody(input: PlatformDemoTransportRequest) {
  if (!input.body) throw new Error("平台 Demo 写请求体缺失");
  try {
    const value: unknown = JSON.parse(input.body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("平台 Demo 写请求体无效");
  }
}

function assertTransportSpotBoundary(
  provider: PlatformDemoProvider,
  url: URL,
  input: PlatformDemoTransportRequest,
) {
  if (!PLATFORM_DEMO_ALLOWED_ROUTES[provider].has(`${input.method} ${url.pathname}`)) {
    throw new Error("平台 Demo transport 路由不在固定白名单");
  }
  const header = (name: string) => Object.entries(input.headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (provider === "okx") {
    if (header("x-simulated-trading") !== "1") throw new Error("OKX Demo 请求缺少模拟交易标记");
    const body = input.method === "POST" ? transportBody(input) : null;
    const instId = String(body?.instId ?? url.searchParams.get("instId") ?? "");
    if (url.pathname !== "/api/v5/account/balance"
      && !["BTC-USDT", "ETH-USDT", "SOL-USDT"].includes(instId)) {
      throw new Error("OKX Demo 仅允许 BTC/ETH/SOL USDT 现货");
    }
    if (url.pathname === "/api/v5/trade/order"
      && input.method === "POST"
      && (body?.tdMode !== "cash" || body?.ordType !== "market")) {
      throw new Error("OKX Demo 仅允许 cash market 现货订单");
    }
    if (url.pathname === "/api/v5/trade/fills" && url.searchParams.get("instType") !== "SPOT") {
      throw new Error("OKX Demo 仅允许 SPOT 成交查询");
    }
    return;
  }
  if (provider === "binance") {
    const symbol = url.searchParams.get("symbol");
    if (url.pathname !== "/api/v3/account"
      && !["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(symbol ?? "")) {
      throw new Error("Binance Demo 仅允许 BTC/ETH/SOL USDT 现货");
    }
    if (url.pathname === "/api/v3/order" && input.method === "POST"
      && url.searchParams.get("type") !== "MARKET") {
      throw new Error("Binance Demo 仅允许 MARKET 现货订单");
    }
    return;
  }
  const body = input.method === "POST" ? transportBody(input) : null;
  const category = String(body?.category ?? url.searchParams.get("category") ?? "");
  if (category !== "spot") throw new Error("Bybit Demo 仅允许 spot 类别");
  if (url.pathname === "/v5/order/create" && (body?.isLeverage !== 0 || body?.orderType !== "Market")) {
    throw new Error("Bybit Demo 禁止杠杆或非市价订单");
  }
}

export class PlatformDemoWritesDisabledError extends Error {
  constructor() {
    super("平台 Demo 外部写调用默认关闭");
    this.name = "PlatformDemoWritesDisabledError";
  }
}

export class PlatformDemoResponseError extends Error {
  readonly unknownExecutionState: boolean;

  constructor(message: string, options: { unknownExecutionState?: boolean } = {}) {
    super(message);
    this.name = "PlatformDemoResponseError";
    this.unknownExecutionState = options.unknownExecutionState === true;
  }
}

export class PlatformDemoSellSafetyError extends Error {
  constructor() {
    super("平台 Demo 现货卖出无法同时证明不超过 10 USDT 且满足 provider filters，已 fail-closed");
    this.name = "PlatformDemoSellSafetyError";
  }
}

export function createPlatformDemoFetchTransport(timeoutMs = 8_000): PlatformDemoTransport {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) throw new Error("平台 Demo HTTP 超时时间无效");
  const allowedOrigins = new Set<string>(Object.values(PLATFORM_DEMO_ENDPOINTS));
  return {
    async request(input) {
      const url = new URL(input.url);
      if (url.protocol !== "https:" || !allowedOrigins.has(url.origin) || url.hash) throw new Error("平台 Demo 请求域名不在固定白名单");
      const provider = (Object.entries(PLATFORM_DEMO_ENDPOINTS) as [PlatformDemoProvider, string][])
        .find(([, origin]) => origin === url.origin)?.[0];
      if (!provider) throw new Error("平台 Demo provider 不在固定白名单");
      assertTransportSpotBoundary(provider, url, input);
      const response = await fetch(url, {
        method: input.method,
        headers: input.headers,
        ...(input.body ? { body: input.body } : {}),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (text.length > 1_000_000) throw new PlatformDemoResponseError("平台 Demo 响应体超过安全上限");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new PlatformDemoResponseError("平台 Demo 响应不是有效 JSON", { unknownExecutionState: response.status >= 500 });
      }
      return { status: response.status, json };
    },
  };
}

function defaultTransport(): PlatformDemoTransport {
  return {
    async request() {
      throw new Error("平台 Demo transport 未显式配置");
    },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlatformDemoResponseError(`${label}响应格式无效`);
  return value as Record<string, unknown>;
}

function rows(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new PlatformDemoResponseError(`${label}响应列表无效`);
  return value.map((item) => record(item, label));
}

function requiredString(value: unknown, label: string, maximum = 128) {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim() || String(value).length > maximum) {
    throw new PlatformDemoResponseError(`${label}响应字段无效`);
  }
  return String(value);
}

function matchingString(value: unknown, expected: string, label: string, maximum = 128) {
  const result = requiredString(value, label, maximum);
  if (result !== expected) throw new PlatformDemoResponseError(`${label}响应标识不匹配`);
  return result;
}

function decimal(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new PlatformDemoResponseError(`${label}响应数值无效`);
  return result;
}

function absoluteDecimal(value: unknown, label: string) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new PlatformDemoResponseError(`${label}响应数值无效`);
  return Math.abs(result);
}

function assertSuccessStatus(status: number, provider: PlatformDemoProvider, unknownExecutionState = false) {
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new PlatformDemoResponseError(`${provider} Demo HTTP 响应失败`, { unknownExecutionState: unknownExecutionState || status >= 500 });
  }
}

async function sendTransportRequest(
  provider: PlatformDemoProvider,
  transport: PlatformDemoTransport,
  input: PlatformDemoTransportRequest,
  unknownExecutionState: boolean,
) {
  try {
    return await transport.request(input);
  } catch (error) {
    if (error instanceof PlatformDemoResponseError
      && (!unknownExecutionState || error.unknownExecutionState)) throw error;
    throw new PlatformDemoResponseError(`${provider} Demo transport 调用失败`, { unknownExecutionState });
  }
}

function originalFee(amount: unknown, currency: unknown, label: string, signed = false) {
  const value = signed ? absoluteDecimal(amount, `${label} fee`) : decimal(amount, `${label} fee`);
  const feeCurrency = requiredString(currency, `${label} fee currency`, 16).toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(feeCurrency)) throw new PlatformDemoResponseError(`${label}手续费币种无效`);
  return {
    feeAmount: value,
    feeCurrency,
    feeUsdt: feeCurrency === "USDT" ? value : null,
  };
}

function normalizeSymbol(value: string): SpotSymbol {
  const symbol = value.replace(/[^a-z0-9]/gi, "").toUpperCase();
  if (symbol !== "BTCUSDT" && symbol !== "ETHUSDT" && symbol !== "SOLUSDT") {
    throw new Error("平台 Demo 仅支持 BTC/ETH/SOL USDT 现货");
  }
  return symbol;
}

function validateClientOrderId(value: string) {
  if (!/^[A-Za-z0-9_-]{8,36}$/.test(value)) throw new Error("平台 Demo clientOrderId 无效");
  return value;
}

function validatePlace(input: {
  symbol: string;
  side: "buy" | "sell";
  quoteAmountUsdt: number;
  baseQuantity?: number;
  clientOrderId: string;
}) {
  const symbol = normalizeSymbol(input.symbol);
  if (input.side !== "buy" && input.side !== "sell") throw new Error("平台 Demo 仅支持现货买卖");
  if (input.quoteAmountUsdt !== 10) throw new Error("平台 Demo 单笔金额固定为 10 USDT");
  if (input.side === "sell" && (!Number.isFinite(input.baseQuantity) || Number(input.baseQuantity) <= 0)) {
    throw new Error("平台 Demo 现货卖出数量无效");
  }
  return { ...input, symbol, clientOrderId: validateClientOrderId(input.clientOrderId) };
}

export function deterministicDemoClientOrderId(input: {
  provider: PlatformDemoProvider;
  strategyCode: StrategyCode;
  decisionRoundId: string;
}) {
  if (!input.decisionRoundId.trim() || input.decisionRoundId.length > 256) throw new Error("Demo 决策轮标识无效");
  return `rv${createHash("sha256").update(`${input.provider}:${input.strategyCode}:${input.decisionRoundId}`).digest("hex").slice(0, 30)}`;
}

type Credentials = { apiKey: string; secret: string; passphrase?: string };
type AdapterOptions = {
  transport?: PlatformDemoTransport;
  now?: () => Date;
  externalWritesEnabled?: boolean;
};

function validateCredentials(provider: PlatformDemoProvider, credentials: Credentials) {
  if (!credentials.apiKey.trim() || !credentials.secret.trim()) throw new Error("平台 Demo 凭证未配置");
  if (provider === "okx" && !credentials.passphrase?.trim()) throw new Error("OKX Demo passphrase 未配置");
}

function orderStatus(value: string) {
  const normalized = value.toLowerCase();
  if (["new", "live", "created", "untriggered", "partiallyfilled", "partially_filled"].includes(normalized)) return "open" as const;
  if (["filled"].includes(normalized)) return "filled" as const;
  if (["canceled", "cancelled", "deactivated"].includes(normalized)) return "cancelled" as const;
  if (["rejected"].includes(normalized)) return "rejected" as const;
  throw new PlatformDemoResponseError("Demo 订单状态响应无效");
}

function okxAdapter(credentials: Credentials, options: Required<AdapterOptions>) {
  const request = async (method: "GET" | "POST", path: string, body?: Record<string, unknown>, unknownExecutionState = false) => {
    const timestamp = options.now().toISOString();
    const bodyText = body ? JSON.stringify(body) : "";
    const signature = createHmac("sha256", credentials.secret).update(`${timestamp}${method}${path}${bodyText}`).digest("base64");
    const response = await sendTransportRequest("okx", options.transport, {
      method,
      url: `${PLATFORM_DEMO_ENDPOINTS.okx}${path}`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "OK-ACCESS-KEY": credentials.apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": credentials.passphrase!,
        "x-simulated-trading": "1",
      },
      ...(body ? { body: bodyText } : {}),
    }, unknownExecutionState);
    assertSuccessStatus(response.status, "okx", unknownExecutionState);
    const payload = record(response.json, "OKX Demo");
    if (payload.code !== "0") throw new PlatformDemoResponseError("OKX Demo 业务响应失败", { unknownExecutionState });
    return rows(payload.data, "OKX Demo");
  };
  const instId = (symbol: string) => `${symbol.slice(0, -4)}-USDT`;
  return {
    provider: "okx" as const,
    async verify() {
      const data = await request("GET", "/api/v5/account/balance");
      if (!data.length) throw new PlatformDemoResponseError("OKX Demo 账户响应为空");
      decimal(data[0].totalEq, "OKX Demo account");
      return { provider: "okx" as const, status: "verified" as const, observedAt: options.now().toISOString() };
    },
    async placeOrder(raw: Parameters<typeof validatePlace>[0]) {
      if (!options.externalWritesEnabled) throw new PlatformDemoWritesDisabledError();
      const input = validatePlace(raw);
      if (input.side === "sell") throw new PlatformDemoSellSafetyError();
      const data = await request("POST", "/api/v5/trade/order", {
        instId: instId(input.symbol), tdMode: "cash", side: input.side, ordType: "market",
        sz: String(input.side === "buy" ? input.quoteAmountUsdt : input.baseQuantity),
        tgtCcy: input.side === "buy" ? "quote_ccy" : "base_ccy", clOrdId: input.clientOrderId,
      }, true);
      const result = data[0];
      if (!result || result.sCode !== "0") throw new PlatformDemoResponseError("OKX Demo 下单响应无效", { unknownExecutionState: true });
      return { provider: "okx" as const, providerOrderId: requiredString(result.ordId, "OKX order"), clientOrderId: matchingString(result.clOrdId, input.clientOrderId, "OKX client order", 36), status: "accepted" as const };
    },
    async getOrder(input: { symbol: string; clientOrderId: string }) {
      const params = new URLSearchParams({ instId: instId(normalizeSymbol(input.symbol)), clOrdId: validateClientOrderId(input.clientOrderId) });
      const result = (await request("GET", `/api/v5/trade/order?${params}`))[0];
      if (!result) throw new PlatformDemoResponseError("OKX Demo 查单响应为空");
      return { provider: "okx" as const, providerOrderId: requiredString(result.ordId, "OKX order"), clientOrderId: matchingString(result.clOrdId, input.clientOrderId, "OKX client order", 36), status: orderStatus(requiredString(result.state, "OKX order state")), filledBaseQuantity: decimal(result.accFillSz, "OKX filled quantity") };
    },
    async cancelOrder(input: { symbol: string; clientOrderId: string }) {
      if (!options.externalWritesEnabled) throw new PlatformDemoWritesDisabledError();
      const data = await request("POST", "/api/v5/trade/cancel-order", { instId: instId(normalizeSymbol(input.symbol)), clOrdId: validateClientOrderId(input.clientOrderId) }, true);
      const result = data[0];
      if (!result || result.sCode !== "0") throw new PlatformDemoResponseError("OKX Demo 撤单响应无效", { unknownExecutionState: true });
      return { provider: "okx" as const, providerOrderId: requiredString(result.ordId, "OKX order"), clientOrderId: matchingString(result.clOrdId, input.clientOrderId, "OKX client order", 36), status: "cancelled" as const };
    },
    async listFills(input: { symbol: string; providerOrderId: string }) {
      const params = new URLSearchParams({ instType: "SPOT", instId: instId(normalizeSymbol(input.symbol)), ordId: requiredString(input.providerOrderId, "OKX order") });
      return (await request("GET", `/api/v5/trade/fills?${params}`)).map((item) => ({
        fillId: requiredString(item.tradeId, "OKX fill"),
        providerOrderId: matchingString(item.ordId, input.providerOrderId, "OKX provider order"),
        baseQuantity: decimal(item.fillSz, "OKX fill quantity"),
        price: decimal(item.fillPx, "OKX fill price"),
        ...originalFee(item.fee, item.feeCcy, "OKX fill", true),
        observedAt: new Date(decimal(item.ts, "OKX fill time")).toISOString(),
      }));
    },
  };
}

function binanceAdapter(credentials: Credentials, options: Required<AdapterOptions>) {
  const request = async (method: "GET" | "POST" | "DELETE", path: string, params: URLSearchParams, unknownExecutionState = false) => {
    params.set("timestamp", String(options.now().getTime()));
    params.set("recvWindow", "5000");
    params.set("signature", createHmac("sha256", credentials.secret).update(params.toString()).digest("hex"));
    const response = await sendTransportRequest("binance", options.transport, {
      method,
      url: `${PLATFORM_DEMO_ENDPOINTS.binance}${path}?${params}`,
      headers: { accept: "application/json", "X-MBX-APIKEY": credentials.apiKey },
    }, unknownExecutionState);
    assertSuccessStatus(response.status, "binance", unknownExecutionState);
    return response.json;
  };
  const parsedOrder = (value: unknown, expectedClientOrderId: string) => {
    const item = record(value, "Binance Demo order");
    return {
      provider: "binance" as const,
      providerOrderId: requiredString(item.orderId, "Binance order"),
      clientOrderId: matchingString(item.clientOrderId, expectedClientOrderId, "Binance client order", 36),
      status: orderStatus(requiredString(item.status, "Binance order state")),
      filledBaseQuantity: item.executedQty === undefined ? 0 : decimal(item.executedQty, "Binance filled quantity"),
    };
  };
  return {
    provider: "binance" as const,
    async verify() {
      const account = record(await request("GET", "/api/v3/account", new URLSearchParams()), "Binance Demo account");
      if (account.accountType !== "SPOT" || account.canTrade !== true) throw new PlatformDemoResponseError("Binance Demo 账户响应无效或不可交易");
      return { provider: "binance" as const, status: "verified" as const, observedAt: options.now().toISOString() };
    },
    async placeOrder(raw: Parameters<typeof validatePlace>[0]) {
      if (!options.externalWritesEnabled) throw new PlatformDemoWritesDisabledError();
      const input = validatePlace(raw);
      if (input.side === "sell") throw new PlatformDemoSellSafetyError();
      const params = new URLSearchParams({ symbol: input.symbol, side: input.side.toUpperCase(), type: "MARKET", newClientOrderId: input.clientOrderId });
      params.set(input.side === "buy" ? "quoteOrderQty" : "quantity", String(input.side === "buy" ? input.quoteAmountUsdt : input.baseQuantity));
      const result = parsedOrder(await request("POST", "/api/v3/order", params, true), input.clientOrderId);
      return { ...result, status: "accepted" as const };
    },
    async getOrder(input: { symbol: string; clientOrderId: string }) {
      return parsedOrder(await request("GET", "/api/v3/order", new URLSearchParams({ symbol: normalizeSymbol(input.symbol), origClientOrderId: validateClientOrderId(input.clientOrderId) })), input.clientOrderId);
    },
    async cancelOrder(input: { symbol: string; clientOrderId: string }) {
      if (!options.externalWritesEnabled) throw new PlatformDemoWritesDisabledError();
      const result = parsedOrder(await request("DELETE", "/api/v3/order", new URLSearchParams({ symbol: normalizeSymbol(input.symbol), origClientOrderId: validateClientOrderId(input.clientOrderId) }), true), input.clientOrderId);
      return { ...result, status: "cancelled" as const };
    },
    async listFills(input: { symbol: string; providerOrderId: string }) {
      const payload = await request("GET", "/api/v3/myTrades", new URLSearchParams({ symbol: normalizeSymbol(input.symbol), orderId: requiredString(input.providerOrderId, "Binance order") }));
      return rows(payload, "Binance Demo fills").map((item) => ({
        fillId: requiredString(item.id, "Binance fill"),
        providerOrderId: matchingString(item.orderId, input.providerOrderId, "Binance provider order"),
        baseQuantity: decimal(item.qty, "Binance fill quantity"),
        price: decimal(item.quoteQty, "Binance fill quote") / Math.max(decimal(item.qty, "Binance fill quantity"), Number.EPSILON),
        ...originalFee(item.commission, item.commissionAsset, "Binance fill"),
        observedAt: new Date(decimal(item.time, "Binance fill time")).toISOString(),
      }));
    },
  };
}

function bybitAdapter(credentials: Credentials, options: Required<AdapterOptions>) {
  const request = async (method: "GET" | "POST", path: string, params: Record<string, unknown>, unknownExecutionState = false) => {
    const timestamp = String(options.now().getTime());
    const recvWindow = "5000";
    const body = method === "POST" ? JSON.stringify(params) : undefined;
    const query = method === "GET" ? new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString() : "";
    const signature = createHmac("sha256", credentials.secret).update(`${timestamp}${credentials.apiKey}${recvWindow}${body || query}`).digest("hex");
    const response = await sendTransportRequest("bybit", options.transport, {
      method,
      url: `${PLATFORM_DEMO_ENDPOINTS.bybit}${path}${query ? `?${query}` : ""}`,
      headers: {
        accept: "application/json", "content-type": "application/json",
        "X-BAPI-API-KEY": credentials.apiKey, "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow,
      },
      ...(body ? { body } : {}),
    }, unknownExecutionState);
    assertSuccessStatus(response.status, "bybit", unknownExecutionState);
    const payload = record(response.json, "Bybit Demo");
    if (payload.retCode !== 0) throw new PlatformDemoResponseError("Bybit Demo 业务响应失败", { unknownExecutionState });
    return record(payload.result, "Bybit Demo result");
  };
  const parsedOrder = (value: Record<string, unknown>, expectedClientOrderId: string) => ({
    provider: "bybit" as const,
    providerOrderId: requiredString(value.orderId, "Bybit order"),
    clientOrderId: matchingString(value.orderLinkId, expectedClientOrderId, "Bybit client order", 36),
    status: orderStatus(requiredString(value.orderStatus, "Bybit order state")),
    filledBaseQuantity: value.cumExecQty === undefined ? 0 : decimal(value.cumExecQty, "Bybit filled quantity"),
  });
  return {
    provider: "bybit" as const,
    async verify() {
      const result = await request("GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" });
      if (!rows(result.list, "Bybit Demo account").length) throw new PlatformDemoResponseError("Bybit Demo 账户响应为空");
      return { provider: "bybit" as const, status: "verified" as const, observedAt: options.now().toISOString() };
    },
    async placeOrder(raw: Parameters<typeof validatePlace>[0]) {
      if (!options.externalWritesEnabled) throw new PlatformDemoWritesDisabledError();
      const input = validatePlace(raw);
      if (input.side === "sell") throw new PlatformDemoSellSafetyError();
      const result = await request("POST", "/v5/order/create", {
        category: "spot", symbol: input.symbol, side: input.side === "buy" ? "Buy" : "Sell",
        orderType: "Market", qty: String(input.side === "buy" ? input.quoteAmountUsdt : input.baseQuantity),
        marketUnit: input.side === "buy" ? "quoteCoin" : "baseCoin", isLeverage: 0, orderLinkId: input.clientOrderId,
      }, true);
      return { provider: "bybit" as const, providerOrderId: requiredString(result.orderId, "Bybit order"), clientOrderId: matchingString(result.orderLinkId, input.clientOrderId, "Bybit client order", 36), status: "accepted" as const };
    },
    async getOrder(input: { symbol: string; clientOrderId: string }) {
      const result = await request("GET", "/v5/order/realtime", { category: "spot", symbol: normalizeSymbol(input.symbol), orderLinkId: validateClientOrderId(input.clientOrderId) });
      const item = rows(result.list, "Bybit Demo orders")[0];
      if (!item) throw new PlatformDemoResponseError("Bybit Demo 查单响应为空");
      return parsedOrder(item, input.clientOrderId);
    },
    async cancelOrder(input: { symbol: string; clientOrderId: string }) {
      if (!options.externalWritesEnabled) throw new PlatformDemoWritesDisabledError();
      const result = await request("POST", "/v5/order/cancel", { category: "spot", symbol: normalizeSymbol(input.symbol), orderLinkId: validateClientOrderId(input.clientOrderId) }, true);
      return {
        provider: "bybit" as const,
        providerOrderId: requiredString(result.orderId, "Bybit order"),
        clientOrderId: matchingString(result.orderLinkId, input.clientOrderId, "Bybit client order", 36),
        status: "cancelled" as const,
      };
    },
    async listFills(input: { symbol: string; providerOrderId: string }) {
      const result = await request("GET", "/v5/execution/list", { category: "spot", symbol: normalizeSymbol(input.symbol), orderId: requiredString(input.providerOrderId, "Bybit order") });
      return rows(result.list, "Bybit Demo fills").map((item) => ({
        fillId: requiredString(item.execId, "Bybit fill"),
        providerOrderId: matchingString(item.orderId, input.providerOrderId, "Bybit provider order"),
        baseQuantity: decimal(item.execQty, "Bybit fill quantity"),
        price: decimal(item.execPrice, "Bybit fill price"),
        ...originalFee(item.execFee, item.feeCurrency, "Bybit fill"),
        observedAt: new Date(decimal(item.execTime, "Bybit fill time")).toISOString(),
      }));
    },
  };
}

export function createPlatformDemoAdapter(
  provider: PlatformDemoProvider,
  credentials: Credentials,
  options: AdapterOptions = {},
) {
  if (provider !== "okx" && provider !== "binance" && provider !== "bybit") throw new Error("不支持的平台 Demo provider");
  validateCredentials(provider, credentials);
  const resolved: Required<AdapterOptions> = {
    transport: options.transport ?? defaultTransport(),
    now: options.now ?? (() => new Date()),
    externalWritesEnabled: options.externalWritesEnabled === true,
  };
  if (provider === "okx") return okxAdapter(credentials, resolved);
  if (provider === "binance") return binanceAdapter(credentials, resolved);
  return bybitAdapter(credentials, resolved);
}

export type PlatformDemoAdapter = ReturnType<typeof createPlatformDemoAdapter>;
