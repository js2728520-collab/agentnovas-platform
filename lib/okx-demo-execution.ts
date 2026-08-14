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

async function okxDemoPrivateRequest<T>(options: {
  credentials: ExchangeCredential;
  method: "GET" | "POST";
  requestPath: string;
  body?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
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
        // This executor is deliberately demo-only. There is no live-mode argument.
        "x-simulated-trading": "1",
      },
      body: body || undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as OkxEnvelope<T> | null;
    if (!response.ok || payload?.code !== "0") {
      throw new ExchangeAdapterError(`OKX Demo 请求失败：${payload?.msg?.trim() || `HTTP ${response.status}`}`);
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

export async function getOkxDemoOrder(options: {
  credentials: ExchangeCredential;
  symbol: string;
  orderId: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}) {
  const instrumentId = okxInstrumentId(options.symbol);
  const requestPath = `/api/v5/trade/order?instId=${encodeURIComponent(instrumentId)}&ordId=${encodeURIComponent(options.orderId)}`;
  const rows = await okxDemoPrivateRequest<RawOrder>({ credentials: options.credentials, fetchImpl: options.fetchImpl, now: options.now, baseUrl: options.baseUrl, method: "GET", requestPath });
  if (!rows[0]) throw new ExchangeAdapterError("OKX Demo 查询不到该订单");
  return parseOrder(rows[0], { orderId: options.orderId, instrumentId });
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
}) {
  const instrumentId = okxInstrumentId(options.symbol);
  const size = options.side === "buy" ? positiveNumber(options.notionalUsdt) : positiveNumber(options.quantity);
  if (!size) throw new ExchangeAdapterError(options.side === "buy" ? "OKX Demo 买入金额无效" : "OKX Demo 卖出数量无效", 400);
  const clientOrderId = options.clientOrderId.replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  if (!clientOrderId) throw new ExchangeAdapterError("OKX Demo 客户端订单编号无效", 400);
  const rows = await okxDemoPrivateRequest<RawOrder>({
    credentials: options.credentials,
    fetchImpl: options.fetchImpl,
    now: options.now,
    baseUrl: options.baseUrl,
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
