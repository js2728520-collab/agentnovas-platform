/**
 * Binance 现货下单与查单。
 *
 * 只做现货：本平台的执行标的恒为 `spot_usdt`，永续在域层与数据库两处被拒
 * （ADR-0019 第 6 步）。因此这里刻意**不引用**任何 fapi 端点——写进来就等于给
 * 未来某个人留了一条把它接上的近路。
 *
 * 与 OKX 那份的差异都在细节上，而细节正是会出事的地方：
 * - 品种是 `BTCUSDT` 而不是 `BTC/USDT`；
 * - 签名是 query string 的 HMAC-SHA256 十六进制，不是 OKX 的 base64；
 * - 幂等字段叫 `newClientOrderId`，查单时叫 `origClientOrderId`；
 * - 查单响应**不含手续费**，必须另查 myTrades（见 getBinanceSpotOrder）。
 */

import { apiBase, ExchangeAdapterError, hmacHex } from "./exchange-adapters.ts";
import type { ExchangeCredential } from "./exchange-credentials.ts";

type FetchLike = typeof fetch;
type Environment = "demo" | "live";

export type BinanceSpotOrder = {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  averagePrice: number;
  filledQuantity: number;
  /** 以计价货币（USDT）计的手续费。查单路径下由 myTrades 汇总得出。 */
  feeUsdt: number;
};

type RawOrder = {
  orderId?: number | string;
  clientOrderId?: string;
  origClientOrderId?: string;
  symbol?: string;
  side?: string;
  status?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  fills?: { price?: string; qty?: string; commission?: string; commissionAsset?: string }[];
  code?: number;
  msg?: string;
};

type RawTrade = { commission?: string; commissionAsset?: string; price?: string; qty?: string };

/** `BTC/USDT` → `BTCUSDT`。Binance 不接受分隔符。 */
export function binanceSymbol(symbol: string): string {
  const normalized = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!normalized) throw new ExchangeAdapterError(`Binance 品种格式无效：${symbol}`, 400);
  return normalized;
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 稳定币计价的手续费直接计入；其它币种按成交均价折算，与 OKX 那份口径一致。 */
function commissionInUsdt(asset: string, amount: number, averagePrice: number): number {
  if (!amount) return 0;
  if (["USDT", "USDC", "BUSD", "FDUSD", "USD"].includes(asset.toUpperCase())) return amount;
  return averagePrice > 0 ? amount * averagePrice : 0;
}

async function binanceSignedRequest<T>(options: {
  credentials: ExchangeCredential;
  environment: Environment;
  method: "GET" | "POST";
  path: string;
  params: Record<string, string>;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<T> {
  const timestamp = String((options.now ?? (() => new Date()))().getTime());
  const query = new URLSearchParams({ ...options.params, recvWindow: "5000", timestamp }).toString();
  const signature = await hmacHex(query, options.credentials.secretKey);
  const url = `${apiBase("BINANCE", options.environment, options.baseUrl)}${options.path}?${query}&signature=${signature}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method,
      headers: { accept: "application/json", "X-MBX-APIKEY": options.credentials.apiKey },
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as (T & { code?: number; msg?: string }) | null;
    if (!payload) throw new ExchangeAdapterError(`Binance 返回了无法解析的响应（HTTP ${response.status}）`);
    // Binance 用负数 code 表示错误；-2013 是「订单不存在」，调用方需要区分它，
    // 因此把 code 原样带进错误消息而不是压平成一句「请求失败」。
    if (typeof payload.code === "number" && payload.code < 0) {
      throw new ExchangeAdapterError(`Binance 请求失败：${payload.code} ${payload.msg?.trim() || ""}`.trim());
    }
    if (!response.ok) throw new ExchangeAdapterError(`Binance 请求失败：HTTP ${response.status}`);
    return payload;
  } catch (error) {
    if (error instanceof ExchangeAdapterError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ExchangeAdapterError("Binance 请求超时");
    throw new ExchangeAdapterError("无法连接 Binance 交易接口");
  } finally {
    clearTimeout(timeout);
  }
}

function toOrder(raw: RawOrder, fallback: { symbol: string; clientOrderId?: string; side?: "buy" | "sell" }): BinanceSpotOrder {
  const filledQuantity = positiveNumber(raw.executedQty);
  const quoteSpent = positiveNumber(raw.cummulativeQuoteQty);
  // Binance 不直接给均价，用「成交额 ÷ 成交量」算。两者任一为 0 时均价就是 0，
  // 由上层的 classifyFill 判定——这里不编造价格。
  const averagePrice = filledQuantity > 0 && quoteSpent > 0 ? quoteSpent / filledQuantity : 0;
  const fees = (raw.fills ?? []).reduce(
    (total, fill) => total + commissionInUsdt(fill.commissionAsset ?? "", Math.abs(Number(fill.commission || 0)) || 0, averagePrice),
    0,
  );
  return {
    orderId: String(raw.orderId ?? ""),
    clientOrderId: raw.clientOrderId || raw.origClientOrderId || fallback.clientOrderId || "",
    symbol: raw.symbol || fallback.symbol,
    side: (raw.side || fallback.side || "buy").toLowerCase() === "sell" ? "sell" : "buy",
    status: raw.status || "NEW",
    averagePrice,
    filledQuantity,
    feeUsdt: fees,
  };
}

export async function placeBinanceSpotMarketOrder(options: {
  credentials: ExchangeCredential;
  environment: Environment;
  symbol: string;
  side: "buy" | "sell";
  /** 买入按计价货币金额（quoteOrderQty），卖出按基础货币数量，与 OKX 口径一致。 */
  quantity: number;
  clientOrderId: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<BinanceSpotOrder> {
  const symbol = binanceSymbol(options.symbol);
  const size = positiveNumber(options.quantity);
  if (!size) throw new ExchangeAdapterError(options.side === "buy" ? "Binance 买入金额无效" : "Binance 卖出数量无效", 400);
  // newClientOrderId 允许的字符比 OKX 宽，但我们派生的 id 已经是 [A-Z0-9]，
  // 这里只做长度兜底，不做静默改写——改写会破坏幂等（同一次重试算出不同 id）。
  const clientOrderId = options.clientOrderId.trim();
  if (!clientOrderId || clientOrderId.length > 36) {
    throw new ExchangeAdapterError("Binance 客户端订单编号无效", 400);
  }

  const raw = await binanceSignedRequest<RawOrder>({
    credentials: options.credentials,
    environment: options.environment,
    method: "POST",
    path: "/api/v3/order",
    params: {
      symbol,
      side: options.side.toUpperCase(),
      type: "MARKET",
      ...(options.side === "buy" ? { quoteOrderQty: String(size) } : { quantity: String(size) }),
      newClientOrderId: clientOrderId,
      // FULL 才会返回 fills，手续费只能从那里拿到。
      newOrderRespType: "FULL",
    },
    fetchImpl: options.fetchImpl,
    now: options.now,
    baseUrl: options.baseUrl,
  });
  return toOrder(raw, { symbol, clientOrderId, side: options.side });
}

/** Binance 的「订单不存在」错误码。 */
const ORDER_DOES_NOT_EXIST = -2013;

export class BinanceOrderNotFoundError extends ExchangeAdapterError {
  constructor(clientOrderId: string) {
    super(`Binance 查询不到该订单：${clientOrderId}`, 404);
    this.name = "BinanceOrderNotFoundError";
  }
}

/**
 * 按我们自己派生的 clientOrderId 查单。超时恢复与对账都走这条路径。
 *
 * 查单响应**不含手续费**，因此成交后会再查一次 myTrades 汇总佣金。多一次调用换
 * 一个真实的费用数字：回执是绩效分成的依据，把未知的手续费当成 0 会让分成算多。
 */
export async function getBinanceSpotOrder(options: {
  credentials: ExchangeCredential;
  environment: Environment;
  symbol: string;
  clientOrderId: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<BinanceSpotOrder> {
  const symbol = binanceSymbol(options.symbol);
  let raw: RawOrder;
  try {
    raw = await binanceSignedRequest<RawOrder>({
      credentials: options.credentials,
      environment: options.environment,
      method: "GET",
      path: "/api/v3/order",
      params: { symbol, origClientOrderId: options.clientOrderId },
      fetchImpl: options.fetchImpl,
      now: options.now,
      baseUrl: options.baseUrl,
    });
  } catch (error) {
    // 只有明确的「订单不存在」才是「不存在」。其它错误必须继续往上抛——
    // 把网络故障当成订单不存在会让对账把真实成交判成未下单，然后重复下单。
    if (error instanceof ExchangeAdapterError && error.message.includes(String(ORDER_DOES_NOT_EXIST))) {
      throw new BinanceOrderNotFoundError(options.clientOrderId);
    }
    throw error;
  }

  const order = toOrder(raw, { symbol, clientOrderId: options.clientOrderId });
  if (order.filledQuantity <= 0 || !order.orderId) return order;

  const trades = await binanceSignedRequest<RawTrade[]>({
    credentials: options.credentials,
    environment: options.environment,
    method: "GET",
    path: "/api/v3/myTrades",
    params: { symbol, orderId: order.orderId },
    fetchImpl: options.fetchImpl,
    now: options.now,
    baseUrl: options.baseUrl,
  });
  const feeUsdt = (Array.isArray(trades) ? trades : []).reduce(
    (total, trade) => total + commissionInUsdt(trade.commissionAsset ?? "", Math.abs(Number(trade.commission || 0)) || 0, order.averagePrice),
    0,
  );
  return { ...order, feeUsdt };
}
