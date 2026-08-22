import type { ExchangeCredential } from "./exchange-credentials.ts";
import {
  EXCHANGE_CAPABILITIES,
  getExchangeCapability,
  normalizeExchange,
} from "./exchange-capabilities.ts";

export type ExchangeEnvironment = "demo" | "live";
type FetchLike = typeof fetch;

export type ExchangePermissionCheck = {
  exchange: string;
  environment: ExchangeEnvironment;
  /** official = signed venue API; local-demo = deterministic local simulator */
  verificationMode: "official" | "local-demo";
  canRead: boolean;
  canTrade: boolean;
  canWithdraw: boolean;
  permissions: string[];
  accountMode?: string;
  positionMode?: string;
};

/**
 * The catalog is deliberately separate from credential storage.  A supported
 * market does not mean that the complete live connector has been shipped yet.
 * Keeping that distinction visible prevents a saved API key from being
 * mistaken for permission-checked, order-capable access.
 */
export type ExchangeAdapterStatus = {
  key: string;
  displayName: string;
  supportsSpot: boolean;
  supportsContracts: boolean;
  contractNote?: string;
  demoVerificationReady: boolean;
  permissionCheckReady: boolean;
  orderRoutingReady: boolean;
  mode: "demo+live" | "registered";
  note: string;
};

export const EXCHANGE_ADAPTER_STATUS: ExchangeAdapterStatus[] = EXCHANGE_CAPABILITIES.map((capability) => {
  // Permission checks are now implemented for all eight registered venues.
  // Order routing remains separately guarded until a venue's sandbox/order
  // contract has passed the execution test suite.
  const ready = !["CRYPTO.COM", "METAMASK", "ROBINHOOD", "HTX"].includes(capability.key);
  return {
    ...capability,
    demoVerificationReady: true,
    permissionCheckReady: ready,
    orderRoutingReady: capability.key === "OKX",
    mode: "demo+live",
    note: capability.key === "OKX"
      ? "官方权限检测与 Demo 订单链路已接入；下单仍须通过硬风控和明确的交易开关"
      : ready
        ? "官方权限检测已接入；订单路由需通过该交易所沙盒验证后开放"
        : "已登记连接目录并支持本地 Demo 绑定；官方权限检测和订单路由待完成独立适配与沙盒验证",
  };
});

export class ExchangeAdapterError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "ExchangeAdapterError";
    this.status = status;
  }
}

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export async function createOkxSignature(
  secretKey: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body = "",
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64(new Uint8Array(signature));
}

function parsePermissions(value: unknown) {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function digestHex(hash: "SHA-256" | "SHA-512", value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(hash, bytes as unknown as BufferSource)));
}

async function hmac(value: string, secret: Uint8Array | string, hash: "SHA-256" | "SHA-512") {
  const rawSecret = typeof secret === "string" ? encoder.encode(secret) : secret;
  const key = await crypto.subtle.importKey("raw", rawSecret as unknown as BufferSource, { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

/**
 * 导出供订单适配器复用：签名逻辑只应该有一份。
 * 权限验证与下单用同一套 HMAC，写两遍迟早会分叉，而分叉的表现是「验证通过但下单
 * 全部 401」——最难查的那类问题。
 */
export async function hmacHex(value: string, secret: string, hash: "SHA-256" | "SHA-512" = "SHA-256") {
  return bytesToHex(await hmac(value, secret, hash));
}

async function hmacBase64(value: string, secret: string, hash: "SHA-256" | "SHA-512" = "SHA-256") {
  return bytesToBase64(await hmac(value, secret, hash));
}

export function apiBase(exchange: string, environment: ExchangeEnvironment, explicit?: string) {
  if (explicit) return explicit.replace(/\/$/, "");
  const key = normalizeExchange(exchange);
  const envKey = environment === "demo" ? "DEMO" : "LIVE";
  const envName = `${key.replace(/[^A-Z0-9]/g, "_")}_API_BASE_URL_${envKey}`;
  const configured = process.env[envName];
  if (configured) return configured.replace(/\/$/, "");
  const defaults: Record<string, string> = {
    BINANCE: environment === "demo" ? "https://testnet.binance.vision" : "https://api.binance.com",
    BYBIT: environment === "demo" ? "https://api-testnet.bybit.com" : "https://api.bybit.com",
    BITGET: "https://api.bitget.com",
    "GATE.IO": "https://api.gateio.ws",
    KUCOIN: environment === "demo" ? "https://openapi-sandbox.kucoin.com" : "https://api.kucoin.com",
    COINBASE: environment === "demo" ? "https://api.sandbox.coinbase.com" : "https://api.coinbase.com",
    KRAKEN: "https://api.kraken.com",
  };
  return defaults[key] || "";
}

async function officialRequest<T>(options: {
  exchange: string;
  url: string;
  init: RequestInit;
  fetchImpl?: FetchLike;
  parse: (value: unknown, response: Response) => T;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(options.url, {
      ...options.init,
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ExchangeAdapterError(`${options.exchange} 权限验证失败：HTTP ${response.status}`);
    return options.parse(payload, response);
  } catch (error) {
    if (error instanceof ExchangeAdapterError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ExchangeAdapterError(`${options.exchange} 权限验证超时，请检查网络或稍后重试`);
    }
    throw new ExchangeAdapterError(`无法连接 ${options.exchange} 权限验证接口，请检查网络和 API 所属环境`);
  } finally {
    clearTimeout(timeout);
  }
}

function result(exchange: string, environment: ExchangeEnvironment, values: Omit<ExchangePermissionCheck, "exchange" | "environment" | "verificationMode">): ExchangePermissionCheck {
  return { exchange, environment, verificationMode: "official", ...values };
}

export async function verifyBinanceConnection(options: {
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<ExchangePermissionCheck> {
  const timestamp = String((options.now ?? (() => new Date()))().getTime());
  const query = `recvWindow=5000&timestamp=${encodeURIComponent(timestamp)}`;
  const signature = await hmacHex(query, options.credentials.secretKey);
  return officialRequest({
    exchange: "Binance",
    url: `${apiBase("BINANCE", options.environment, options.baseUrl)}/api/v3/account?${query}&signature=${signature}`,
    init: { method: "GET", headers: { accept: "application/json", "X-MBX-APIKEY": options.credentials.apiKey } },
    fetchImpl: options.fetchImpl,
    parse: (payload) => {
      const data = payload as { code?: number; msg?: string; canTrade?: boolean; canWithdraw?: boolean; canDeposit?: boolean; accountType?: string; permissions?: unknown[] };
      if (typeof data.code === "number" && data.code !== 0) throw new ExchangeAdapterError(`Binance 权限验证失败：${data.msg || `错误码 ${data.code}`}`);
      return result("BINANCE", options.environment, {
        canRead: true,
        canTrade: data.canTrade !== false,
        canWithdraw: data.canWithdraw === true,
        permissions: ["read", ...(data.canTrade !== false ? ["trade"] : []), ...(data.canWithdraw === true ? ["withdraw"] : [])],
        accountMode: data.accountType,
      });
    },
  });
}

export async function verifyBybitConnection(options: {
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<ExchangePermissionCheck> {
  const timestamp = String((options.now ?? (() => new Date()))().getTime());
  const recvWindow = "5000";
  const query = "accountType=UNIFIED";
  const signature = await hmacHex(`${timestamp}${options.credentials.apiKey}${recvWindow}${query}`, options.credentials.secretKey);
  return officialRequest({
    exchange: "Bybit",
    url: `${apiBase("BYBIT", options.environment, options.baseUrl)}/v5/account/wallet-balance?${query}`,
    init: { method: "GET", headers: { accept: "application/json", "X-BAPI-API-KEY": options.credentials.apiKey, "X-BAPI-SIGN": signature, "X-BAPI-SIGN-TYPE": "2", "X-BAPI-TIMESTAMP": timestamp, "X-BAPI-RECV-WINDOW": recvWindow } },
    fetchImpl: options.fetchImpl,
    parse: (payload) => {
      const data = payload as { retCode?: number; retMsg?: string; result?: { list?: unknown[] } };
      if (data.retCode !== 0) throw new ExchangeAdapterError(`Bybit 权限验证失败：${data.retMsg || `错误码 ${data.retCode}`}`);
      return result("BYBIT", options.environment, { canRead: true, canTrade: true, canWithdraw: false, permissions: ["read", "trade"], accountMode: "UNIFIED" });
    },
  });
}

export async function verifyBitgetConnection(options: {
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<ExchangePermissionCheck> {
  if (!options.credentials.passphrase) throw new ExchangeAdapterError("Bitget Passphrase 缺失", 400);
  const timestamp = String((options.now ?? (() => new Date()))().getTime());
  const requestPath = "/api/v2/spot/account/assets";
  const signature = await hmacBase64(`${timestamp}GET${requestPath}`, options.credentials.secretKey);
  return officialRequest({
    exchange: "Bitget",
    url: `${apiBase("BITGET", options.environment, options.baseUrl)}${requestPath}`,
    init: { method: "GET", headers: { accept: "application/json", "ACCESS-KEY": options.credentials.apiKey, "ACCESS-SIGN": signature, "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": options.credentials.passphrase, "Content-Type": "application/json", ...(options.environment === "demo" ? { paptrading: "1" } : {}) } },
    fetchImpl: options.fetchImpl,
    parse: (payload) => {
      const data = payload as { code?: string; msg?: string };
      if (data.code !== "00000") throw new ExchangeAdapterError(`Bitget 权限验证失败：${data.msg || data.code || "未知错误"}`);
      return result("BITGET", options.environment, { canRead: true, canTrade: true, canWithdraw: false, permissions: ["read", "trade"] });
    },
  });
}

export async function verifyGateConnection(options: {
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<ExchangePermissionCheck> {
  const method = "GET";
  const path = "/api/v4/spot/accounts";
  const timestamp = String(Math.floor((options.now ?? (() => new Date()))().getTime() / 1000));
  const bodyHash = await digestHex("SHA-512", "");
  const signature = await hmacHex(`${method}\n${path}\n\n${bodyHash}\n${timestamp}`, options.credentials.secretKey, "SHA-512");
  return officialRequest({
    exchange: "Gate.io",
    url: `${apiBase("GATE.IO", options.environment, options.baseUrl)}${path}`,
    init: { method, headers: { accept: "application/json", KEY: options.credentials.apiKey, SIGN: signature, Timestamp: timestamp } },
    fetchImpl: options.fetchImpl,
    parse: (payload) => {
      if (!Array.isArray(payload)) throw new ExchangeAdapterError("Gate.io 权限验证失败：返回格式不正确");
      return result("GATE.IO", options.environment, { canRead: true, canTrade: true, canWithdraw: false, permissions: ["read", "trade"] });
    },
  });
}

export async function verifyKucoinConnection(options: {
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<ExchangePermissionCheck> {
  if (!options.credentials.passphrase) throw new ExchangeAdapterError("KuCoin Passphrase 缺失", 400);
  const timestamp = String((options.now ?? (() => new Date()))().getTime());
  const path = "/api/v1/accounts";
  const signature = await hmacBase64(`${timestamp}GET${path}`, options.credentials.secretKey);
  const passphrase = await hmacBase64(options.credentials.passphrase, options.credentials.secretKey);
  return officialRequest({
    exchange: "KuCoin",
    url: `${apiBase("KUCOIN", options.environment, options.baseUrl)}${path}`,
    init: { method: "GET", headers: { accept: "application/json", "KC-API-KEY": options.credentials.apiKey, "KC-API-SIGN": signature, "KC-API-TIMESTAMP": timestamp, "KC-API-PASSPHRASE": passphrase, "KC-API-KEY-VERSION": "2" } },
    fetchImpl: options.fetchImpl,
    parse: (payload) => {
      const data = payload as { code?: string; msg?: string; data?: unknown[] };
      if (data.code !== "200000") throw new ExchangeAdapterError(`KuCoin 权限验证失败：${data.msg || data.code || "未知错误"}`);
      return result("KUCOIN", options.environment, { canRead: true, canTrade: true, canWithdraw: false, permissions: ["read", "trade"] });
    },
  });
}

function pemToBytes(value: string) {
  const base64 = value.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s/g, "");
  return base64ToBytes(base64);
}

function rawEcdsaSignature(signature: Uint8Array) {
  if (signature.length === 64) return signature;
  if (signature[0] !== 0x30) return signature;
  let offset = 2;
  const readInteger = () => {
    if (signature[offset++] !== 0x02) throw new Error("invalid ECDSA signature");
    const length = signature[offset++];
    const value = signature.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const normalize = (value: Uint8Array) => {
    const normalized = new Uint8Array(32);
    normalized.set(value.slice(-32), 32 - Math.min(value.length, 32));
    return normalized;
  };
  const r = normalize(readInteger());
  const s = normalize(readInteger());
  const combined = new Uint8Array(64);
  combined.set(r, 0); combined.set(s, 32);
  return combined;
}

export async function verifyCoinbaseConnection(options: {
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<ExchangePermissionCheck> {
  let privateKey = options.credentials.secretKey;
  try {
    const parsed = JSON.parse(privateKey) as { privateKey?: string; secret?: string };
    privateKey = parsed.privateKey || parsed.secret || privateKey;
  } catch { /* PEM is also accepted directly. */ }
  if (!privateKey.includes("BEGIN")) throw new ExchangeAdapterError("Coinbase 需要 CDP API Key 对应的 EC 私钥（PEM）", 400);
  const baseUrl = apiBase("COINBASE", options.environment, options.baseUrl);
  const host = new URL(baseUrl).host;
  const path = "/api/v3/brokerage/accounts";
  const now = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
  const header = { alg: "ES256", kid: options.credentials.apiKey, nonce: crypto.randomUUID().replace(/-/g, "") };
  const payload = { sub: options.credentials.apiKey, iss: "cdp", nbf: now, exp: now + 120, uri: `GET ${host}${path}` };
  const encoded = (value: unknown) => bytesToBase64(encoder.encode(JSON.stringify(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const signingInput = `${encoded(header)}.${encoded(payload)}`;
  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemToBytes(privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new ExchangeAdapterError("Coinbase EC 私钥格式无效，请粘贴完整 PEM 私钥", 400);
  }
  const signature = bytesToBase64(rawEcdsaSignature(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(signingInput))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return officialRequest({
    exchange: "Coinbase",
    url: `${baseUrl}${path}`,
    init: { method: "GET", headers: { accept: "application/json", Authorization: `Bearer ${signingInput}.${signature}` } },
    fetchImpl: options.fetchImpl,
    parse: (response) => {
      if (!response || typeof response !== "object" || !("accounts" in response)) throw new ExchangeAdapterError("Coinbase 权限验证失败：返回格式不正确");
      return result("COINBASE", options.environment, { canRead: true, canTrade: true, canWithdraw: false, permissions: ["read", "trade"], accountMode: "spot" });
    },
  });
}

export async function verifyKrakenConnection(options: {
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<ExchangePermissionCheck> {
  const path = "/0/private/Balance";
  const nonce = String((options.now ?? (() => new Date()))().getTime());
  const postData = `nonce=${encodeURIComponent(nonce)}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(nonce + postData)));
  // Kraken signs path || SHA256(nonce + postdata), not the textual digest.
  const signedBytes = new Uint8Array(encoder.encode(path).length + digest.length);
  signedBytes.set(encoder.encode(path), 0); signedBytes.set(digest, encoder.encode(path).length);
  const signedKey = await crypto.subtle.importKey("raw", base64ToBytes(options.credentials.secretKey), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const signed = bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", signedKey, signedBytes)));
  return officialRequest({
    exchange: "Kraken",
    url: `${apiBase("KRAKEN", options.environment, options.baseUrl)}${path}`,
    init: { method: "POST", headers: { accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "API-Key": options.credentials.apiKey, "API-Sign": signed }, body: postData },
    fetchImpl: options.fetchImpl,
    parse: (payload) => {
      const data = payload as { error?: string[]; result?: Record<string, unknown> };
      if (data.error?.length) throw new ExchangeAdapterError(`Kraken 权限验证失败：${data.error.join("；")}`);
      if (!data.result) throw new ExchangeAdapterError("Kraken 权限验证失败：返回格式不正确");
      return result("KRAKEN", options.environment, { canRead: true, canTrade: true, canWithdraw: false, permissions: ["read", "trade"], accountMode: "spot" });
    },
  });
}

export async function verifyOkxConnection(options: {
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}): Promise<ExchangePermissionCheck> {
  const { credentials, environment } = options;
  if (!credentials.passphrase) throw new ExchangeAdapterError("OKX Passphrase 缺失", 400);

  const requestPath = "/api/v5/account/config";
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const signature = await createOkxSignature(
    credentials.secretKey,
    timestamp,
    "GET",
    requestPath,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const baseUrl = (options.baseUrl ?? process.env.OKX_API_BASE_URL ?? "https://www.okx.com").replace(/\/$/, "");

  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}${requestPath}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "OK-ACCESS-KEY": credentials.apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": credentials.passphrase,
        ...(environment === "demo" ? { "x-simulated-trading": "1" } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as {
      code?: string;
      msg?: string;
      data?: Array<{ perm?: string | string[]; acctLv?: string; posMode?: string }>;
    } | null;
    if (!response.ok || payload?.code !== "0" || !payload.data?.[0]) {
      const reason = payload?.msg?.trim() || `HTTP ${response.status}`;
      throw new ExchangeAdapterError(`OKX 权限验证失败：${reason}`);
    }

    const account = payload.data[0];
    const permissions = parsePermissions(account.perm);
    return {
      exchange: "OKX",
      environment,
      verificationMode: "official",
      canRead: permissions.includes("read_only") || permissions.includes("read") || permissions.length > 0,
      canTrade: permissions.includes("trade"),
      canWithdraw: permissions.includes("withdraw"),
      permissions,
      accountMode: account.acctLv,
      positionMode: account.posMode,
    };
  } catch (error) {
    if (error instanceof ExchangeAdapterError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ExchangeAdapterError("OKX 权限验证超时，请检查网络或稍后重试");
    }
    throw new ExchangeAdapterError("无法连接 OKX 权限验证接口，请检查网络和 API 所属环境");
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The first rollout supports a local simulated account for every registered
 * venue. It deliberately never sends the supplied credential to a venue and
 * never enables live trading. This lets users exercise the complete follow
 * workflow while each venue's official signing/order connector is completed.
 */
function verifyRegisteredDemoConnection(exchange: string): ExchangePermissionCheck {
  const capability = getExchangeCapability(exchange);
  if (!capability) throw new ExchangeAdapterError("该交易所尚未登记，无法进行模拟盘检测", 400);
  return {
    exchange: capability.key,
    environment: "demo",
    verificationMode: "local-demo",
    canRead: true,
    canTrade: true,
    canWithdraw: false,
    permissions: ["demo_simulation", "read", "trade"],
  };
}

export async function verifyExchangeConnection(options: {
  exchange: string;
  credentials: ExchangeCredential;
  environment: ExchangeEnvironment;
  fetchImpl?: FetchLike;
  now?: () => Date;
  baseUrl?: string;
}) {
  const exchange = normalizeExchange(options.exchange);
  const capability = getExchangeCapability(exchange);
  if (!capability) {
    throw new ExchangeAdapterError("该交易所尚未登记，无法进行权限检测", 400);
  }
  if (exchange === "OKX") return verifyOkxConnection(options);
  if (options.environment === "demo") return verifyRegisteredDemoConnection(exchange);
  const officialOptions = { credentials: options.credentials, environment: options.environment, fetchImpl: options.fetchImpl, now: options.now, baseUrl: options.baseUrl };
  switch (exchange) {
    case "BINANCE": return verifyBinanceConnection(officialOptions);
    case "BYBIT": return verifyBybitConnection(officialOptions);
    case "BITGET": return verifyBitgetConnection(officialOptions);
    case "GATE.IO": return verifyGateConnection(officialOptions);
    case "KUCOIN": return verifyKucoinConnection(officialOptions);
    case "COINBASE": return verifyCoinbaseConnection(officialOptions);
    case "KRAKEN": return verifyKrakenConnection(officialOptions);
    default: throw new ExchangeAdapterError(`${capability.displayName} 的官方权限检测适配器暂未接入`, 501);
  }
}
