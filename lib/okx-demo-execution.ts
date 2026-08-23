import type { ExchangeCredential } from "./exchange-credentials.ts";
import { createOkxSignature, ExchangeAdapterError } from "./exchange-adapters.ts";

type FetchLike = typeof fetch;

type OkxEnvelope<T> = {
  code?: string;
  msg?: string;
  data?: T[];
};

export type OkxDemoOrder = {
  orderId: string;
  clientOrderId: string;
  instrumentId: string;
  side: "buy" | "sell";
  state: string;
  averagePrice: number;
  filledQuantity: number;
  fee: number;
  feeCurrency: string;
};

type RawOrder = {
  ordId?: string;
  clOrdId?: string;
  instId?: string;
  side?: "buy" | "sell";
  state?: string;
  avgPx?: string;
  accFillSz?: string;
  fee?: string;
  feeCcy?: string;
  sCode?: string;
  sMsg?: string;
};

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function okxBaseUrl(value?: string) {
  return (value ?? process.env.OKX_API_BASE_URL ?? "https://www.okx.com").replace(/\/$/, "");
}

export function okxInstrumentId(symbol: string) {
  const normalized = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const quote = ["USDT", "USDC", "USD", "BTC", "ETH"].find((candidate) => normalized.endsWith(candidate));
  if (!quote || normalized.length <= quote.length) throw new ExchangeAdapterError(`暂不支持将 ${symbol} 转换为 OKX 交易产品`, 400);
  return `${normalized.slice(0, -quote.length)}-${quote}`;
}

function parseOrder(raw: RawOrder, fallback: Partial<OkxDemoOrder> = {}): OkxDemoOrder {
  const orderId = raw.ordId || fallback.orderId || "";
  if (!orderId) throw new ExchangeAdapterError("OKX Demo 未返回订单编号");
  return {
    orderId,
    clientOrderId: raw.clOrdId || fallback.clientOrderId || "",
    instrumentId: raw.instId || fallback.instrumentId || "",
    side: raw.side || fallback.side || "buy",
    state: raw.state || fallback.state || "submitted",
    averagePrice: positiveNumber(raw.avgPx),
    filledQuantity: positiveNumber(raw.accFillSz),
    fee: Math.abs(Number(raw.fee || 0)) || 0,
    feeCurrency: raw.feeCcy || "",
  };
}

/**
 * OKX 的模拟盘与实盘是**同一套 REST API**，区别只有一个请求头：
 * `x-simulated-trading: 1` 走模拟盘，不带它走实盘。
 *
 * 因此这里用一个显式的 environment 参数区分，而不是两份实现。默认 demo——
 * 一个默认走实盘的执行器等于把 execution_live_routing 的灰度闸门绕过去了
 * （与 binance-adapter 同一条规则）。
 */
export type OkxEnvironment = "demo" | "live";

async function okxPrivateRequest<T>(options: {
  credentials: ExchangeCredential;
  method: "GET" | "POST";
  requestPath: string;
  body?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
  environment?: OkxEnvironment;
}) {
  if (!options.credentials.passphrase) throw new ExchangeAdapterError("OKX Passphrase 缺失", 400);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const body = options.body ? JSON.stringify(options.body) : "";
  const signature = await createOkxSignature(options.credentials.secretKey, timestamp, options.method, options.requestPath, body);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${okxBaseUrl(options.baseUrl)}${options.requestPath}`, {
      method: options.method,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": options.credentials.apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": options.credentials.passphrase,
        // 只有 demo 才带这个头。默认值在参数解构处，不在这里——
        // 让「不传 environment 会发生什么」在签名上就能看到。
        ...((options.environment ?? "demo") === "demo" ? { "x-simulated-trading": "1" } : {}),
      },
      body: body || undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as OkxEnvelope<T> | null;
    if (!response.ok || payload?.code !== "0") {
      const label = (options.environment ?? "demo") === "demo" ? "OKX Demo" : "OKX";
      throw new ExchangeAdapterError(`${label} 请求失败：${payload?.msg?.trim() || `HTTP ${response.status}`}`);
    }
    return payload.data ?? [];
  } catch (error) {
    if (error instanceof ExchangeAdapterError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ExchangeAdapterError("OKX Demo 请求超时");
    throw new ExchangeAdapterError("无法连接 OKX Demo 交易接口");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 查单。可以用交易所订单号，也可以用我们自己派生的 clientOrderId。
 *
 * 后者是超时恢复的**唯一**入口：请求发出去、回应没回来时，我们从来没拿到过
 * ordId，只有自己算出来的 clOrdId。没有这条路径，确定性 clientOrderId 就只能防
 * 重复下单，不能回答「那一单到底成没成」——而后者才是超时最难受的地方
 * （ADR-0019 第 3 步）。
 */
export async function getOkxDemoOrder(options: {
  credentials: ExchangeCredential;
  symbol: string;
  orderId?: string;
  clientOrderId?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
  environment?: OkxEnvironment;
}) {
  const instrumentId = okxInstrumentId(options.symbol);
  const selector = options.orderId
    ? `ordId=${encodeURIComponent(options.orderId)}`
    : options.clientOrderId
      ? `clOrdId=${encodeURIComponent(options.clientOrderId)}`
      : null;
  if (!selector) throw new ExchangeAdapterError("OKX Demo 查单必须给出 orderId 或 clientOrderId", 400);
  const requestPath = `/api/v5/trade/order?instId=${encodeURIComponent(instrumentId)}&${selector}`;
  const rows = await okxPrivateRequest<RawOrder>({ credentials: options.credentials, fetchImpl: options.fetchImpl, now: options.now, baseUrl: options.baseUrl, environment: options.environment, method: "GET", requestPath });
  if (!rows[0]) throw new ExchangeAdapterError("OKX Demo 查询不到该订单");
  return parseOrder(rows[0], { orderId: options.orderId, clientOrderId: options.clientOrderId, instrumentId });
}

export async function placeOkxDemoMarketOrder(options: {
  credentials: ExchangeCredential;
  symbol: string;
  side: "buy" | "sell";
  notionalUsdt?: number;
  quantity?: number;
  clientOrderId: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
  environment?: OkxEnvironment;
}) {
  const instrumentId = okxInstrumentId(options.symbol);
  const size = options.side === "buy" ? positiveNumber(options.notionalUsdt) : positiveNumber(options.quantity);
  if (!size) throw new ExchangeAdapterError(options.side === "buy" ? "OKX Demo 买入金额无效" : "OKX Demo 卖出数量无效", 400);
  const clientOrderId = options.clientOrderId.replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  if (!clientOrderId) throw new ExchangeAdapterError("OKX Demo 客户端订单编号无效", 400);
  const rows = await okxPrivateRequest<RawOrder>({
    credentials: options.credentials,
    fetchImpl: options.fetchImpl,
    now: options.now,
    baseUrl: options.baseUrl,
    environment: options.environment,
    method: "POST",
    requestPath: "/api/v5/trade/order",
    body: {
      instId: instrumentId,
      tdMode: "cash",
      side: options.side,
      ordType: "market",
      sz: String(size),
      tgtCcy: options.side === "buy" ? "quote_ccy" : "base_ccy",
      clOrdId: clientOrderId,
    },
  });
  const acknowledgement = rows[0];
  if (!acknowledgement || acknowledgement.sCode && acknowledgement.sCode !== "0") {
    throw new ExchangeAdapterError(`OKX Demo 下单失败：${acknowledgement?.sMsg?.trim() || "未返回订单结果"}`);
  }
  const accepted = parseOrder(acknowledgement, { clientOrderId, instrumentId, side: options.side, state: "submitted" });
  try {
    return await getOkxDemoOrder({ ...options, orderId: accepted.orderId });
  } catch {
    // The acknowledgement is still persisted and can be synchronized in the next cycle.
    return accepted;
  }
}

export function okxFeeInUsdt(order: OkxDemoOrder) {
  if (!order.fee) return 0;
  if (["USDT", "USDC", "USD"].includes(order.feeCurrency.toUpperCase())) return order.fee;
  return order.averagePrice > 0 ? order.fee * order.averagePrice : 0;
}
