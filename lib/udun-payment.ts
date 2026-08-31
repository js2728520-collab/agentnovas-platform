import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ResearchApiError } from "./research-errors.ts";

const UDUN_HOST_PATTERN = /(?:^|\.)udun\.io$/i;
const AGENTNOVAS_HOST_PATTERN = /(?:^|\.)agentnovas\.com$/i;
const CALLBACK_MAX_SKEW_MS = 5 * 60 * 1_000;

export type UdunSignedEnvelope = {
  timestamp: string;
  nonce: string;
  sign: string;
  body: string;
};

export type UdunAddressRequestCoinField = "mainCoinType" | "coinType";

export type UdunDepositCallback = {
  address: string;
  amount: string;
  amountBaseUnits: string;
  blockHeight: string | null;
  coinType: string;
  decimals: number;
  eventId: string;
  feeBaseUnits: string;
  mainCoinType: string;
  status: number;
  tradeType: 1;
  txId: string;
};

export function createUdunSignature(input: {
  body: string;
  key: string;
  nonce: string;
  timestamp: string;
}) {
  return createHash("md5")
    .update(`${input.body}${input.key}${input.nonce}${input.timestamp}`, "utf8")
    .digest("hex")
    .toLowerCase();
}

export function verifyUdunEnvelope(input: UdunSignedEnvelope & { key: string }) {
  if (!/^[a-f0-9]{32}$/i.test(input.sign)) return false;
  const expected = Buffer.from(createUdunSignature(input), "hex");
  const supplied = Buffer.from(input.sign.toLowerCase(), "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function parseUdunEnvelope(value: unknown): UdunSignedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("UDUN_ENVELOPE_INVALID");
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (keys.length !== 4 || keys.join(",") !== "body,nonce,sign,timestamp") throw new Error("UDUN_ENVELOPE_INVALID");
  const timestamp = String(source.timestamp ?? "").trim();
  const nonce = String(source.nonce ?? "").trim();
  const sign = String(source.sign ?? "").trim();
  const body = typeof source.body === "string" ? source.body : "";
  if (!/^\d{10,16}$/.test(timestamp) || !/^[A-Za-z0-9._:-]{1,128}$/.test(nonce)
    || !/^[a-f0-9]{32}$/i.test(sign) || !body || Buffer.byteLength(body, "utf8") > 48_000) {
    throw new Error("UDUN_ENVELOPE_INVALID");
  }
  return { timestamp, nonce, sign: sign.toLowerCase(), body };
}

export function parseUdunHttpEnvelope(contentType: string | null, raw: string): UdunSignedEnvelope {
  const mediaType = String(contentType ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/json") {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("UDUN_ENVELOPE_INVALID"); }
    return parseUdunEnvelope(value);
  }
  if (mediaType !== "application/x-www-form-urlencoded") throw new Error("UDUN_CONTENT_TYPE_INVALID");
  const params = new URLSearchParams(raw);
  const expectedKeys = ["body", "nonce", "sign", "timestamp"];
  const suppliedKeys = [...params.keys()].sort();
  if (suppliedKeys.length !== expectedKeys.length || suppliedKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("UDUN_ENVELOPE_INVALID");
  }
  const value = Object.fromEntries(expectedKeys.map((key) => [key, params.get(key)]));
  return parseUdunEnvelope(value);
}

export function assertFreshUdunTimestamp(timestamp: string, now = Date.now()) {
  const numeric = Number(timestamp);
  if (!Number.isSafeInteger(numeric)) throw new Error("UDUN_TIMESTAMP_INVALID");
  const milliseconds = timestamp.length <= 10 ? numeric * 1_000 : numeric;
  if (Math.abs(now - milliseconds) > CALLBACK_MAX_SKEW_MS) throw new Error("UDUN_CALLBACK_EXPIRED");
  return milliseconds;
}

export function udunBaseUnitsToDecimal(amount: string, decimals: number) {
  if (!/^\d+$/.test(amount)) throw new Error("UDUN_AMOUNT_INVALID");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("UDUN_DECIMALS_INVALID");
  const normalized = amount.replace(/^0+(?=\d)/, "");
  if (normalized.length > decimals + 18) throw new Error("UDUN_AMOUNT_INVALID");
  const padded = normalized.padStart(decimals + 1, "0");
  if (decimals === 0) return padded;
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function requiredText(source: Record<string, unknown>, key: string, maximum = 512) {
  const value = String(source[key] ?? "").trim();
  if (!value || value.length > maximum) throw new Error(`UDUN_CALLBACK_${key.toUpperCase()}_INVALID`);
  return value;
}

export function parseUdunDepositCallback(body: string): UdunDepositCallback {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error("UDUN_CALLBACK_BODY_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("UDUN_CALLBACK_BODY_INVALID");
  const source = value as Record<string, unknown>;
  if (Number(source.tradeType) !== 1) throw new Error("UDUN_CALLBACK_NOT_DEPOSIT");
  const status = Number(source.status);
  if (!Number.isInteger(status) || status < 0 || status > 4) throw new Error("UDUN_CALLBACK_STATUS_INVALID");
  const decimals = Number(source.decimals);
  const amountBaseUnits = requiredText(source, "amount", 80);
  const feeBaseUnits = String(source.fee ?? "0").trim();
  if (!/^\d{1,80}$/.test(feeBaseUnits)) throw new Error("UDUN_CALLBACK_FEE_INVALID");
  const txIdCamel = source.txId === undefined || source.txId === null ? "" : String(source.txId).trim();
  const txIdLower = source.txid === undefined || source.txid === null ? "" : String(source.txid).trim();
  if ((txIdCamel && txIdLower && txIdCamel !== txIdLower) || (!txIdCamel && !txIdLower)) {
    throw new Error("UDUN_CALLBACK_TXID_INVALID");
  }
  const txId = (txIdCamel || txIdLower).slice(0, 257);
  if (txId.length > 256) throw new Error("UDUN_CALLBACK_TXID_INVALID");
  const tradeId = requiredText(source, "tradeId", 256);
  return {
    address: requiredText(source, "address", 256),
    amount: udunBaseUnitsToDecimal(amountBaseUnits, decimals),
    amountBaseUnits,
    blockHeight: source.blockHigh === undefined || source.blockHigh === null ? null : String(source.blockHigh).slice(0, 128),
    coinType: requiredText(source, "coinType", 128),
    decimals,
    eventId: tradeId,
    feeBaseUnits,
    mainCoinType: requiredText(source, "mainCoinType", 128),
    status,
    tradeType: 1,
    txId,
  };
}

export function normalizeUdunGatewayBaseUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("UDUN_GATEWAY_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || !UDUN_HOST_PATTERN.test(url.hostname)
    || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("UDUN_GATEWAY_URL_INVALID");
  }
  return url.origin;
}

export function parseUdunAddressResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("UDUN_ADDRESS_RESPONSE_INVALID");
  const source = value as Record<string, unknown>;
  const code = Number(source.code);
  if (code !== 200) throw new Error(`UDUN_PROVIDER_ERROR:${Number.isFinite(code) ? code : "UNKNOWN"}`);
  if (!source.data || typeof source.data !== "object" || Array.isArray(source.data)) throw new Error("UDUN_ADDRESS_RESPONSE_INVALID");
  const data = source.data as Record<string, unknown>;
  const address = String(data.address ?? "").trim();
  const coinType = String(data.coinType ?? data.mainCoinType ?? "").trim();
  if (!address || address.length > 256 || !coinType || coinType.length > 128) throw new Error("UDUN_ADDRESS_RESPONSE_INVALID");
  return { address, coinType };
}

export type UdunRuntimeConfig = {
  gatewayBaseUrl: string;
  merchantId: string;
  apiKey: string;
  callbackUrl: string;
  addressRequestCoinField: UdunAddressRequestCoinField;
};

async function boundedJsonResponse(response: Response, maximumBytes: number, code: string) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error(code);
  const raw = await response.text();
  if (!raw || Buffer.byteLength(raw, "utf8") > maximumBytes) throw new Error(code);
  try { return JSON.parse(raw) as unknown; }
  catch { throw new Error(code); }
}

export function readUdunRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): UdunRuntimeConfig {
  const gateway = environment.UDUN_GATEWAY_BASE_URL?.trim() ?? "";
  const merchantId = environment.UDUN_MERCHANT_ID?.trim() ?? "";
  const apiKey = environment.UDUN_API_KEY?.trim() ?? "";
  const callbackUrl = environment.UDUN_CALLBACK_URL?.trim() ?? "";
  const addressRequestCoinField = environment.UDUN_ADDRESS_REQUEST_COIN_FIELD?.trim() || "mainCoinType";
  if (!gateway || !merchantId || !apiKey || !callbackUrl) {
    throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "优盾商户网关尚未完整配置", 503, {
      provider: "udun",
      missing: [
        !gateway && "UDUN_GATEWAY_BASE_URL",
        !merchantId && "UDUN_MERCHANT_ID",
        !apiKey && "UDUN_API_KEY",
        !callbackUrl && "UDUN_CALLBACK_URL",
      ].filter(Boolean),
    });
  }
  if (!/^\d{1,32}$/.test(merchantId) || apiKey.length < 8 || apiKey.length > 256 || /\s/.test(apiKey)) {
    throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "优盾商户号或 API Key 配置无效", 503, { provider: "udun" });
  }
  const normalizedCallback = new URL(callbackUrl);
  if (normalizedCallback.protocol !== "https:" || normalizedCallback.username || normalizedCallback.password
    || normalizedCallback.port || !AGENTNOVAS_HOST_PATTERN.test(normalizedCallback.hostname)
    || normalizedCallback.pathname !== "/api/integrations/payments/udun/webhook" || normalizedCallback.search || normalizedCallback.hash) {
    throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "优盾回调地址配置无效", 503, { provider: "udun" });
  }
  if (addressRequestCoinField !== "mainCoinType" && addressRequestCoinField !== "coinType") {
    throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "优盾地址协议版本配置无效", 503, { provider: "udun" });
  }
  return {
    gatewayBaseUrl: normalizeUdunGatewayBaseUrl(gateway), merchantId, apiKey,
    callbackUrl: normalizedCallback.href, addressRequestCoinField,
  };
}

export async function requestUdunDepositAddress(input: {
  config: UdunRuntimeConfig;
  mainCoinType: string;
  alias: string;
  walletId?: string | null;
  fetcher?: typeof fetch;
}) {
  const numericMainCoinType = Number(input.mainCoinType);
  if (!/^\d{1,20}$/.test(input.mainCoinType) || !Number.isSafeInteger(numericMainCoinType)) {
    throw new Error("UDUN_MAIN_COIN_TYPE_INVALID");
  }
  const body = JSON.stringify([{
    merchantId: input.config.merchantId,
    [input.config.addressRequestCoinField]: numericMainCoinType,
    callUrl: input.config.callbackUrl,
    alias: input.alias.slice(0, 100),
    ...(input.walletId ? { walletId: input.walletId } : {}),
  }]);
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const payload = { timestamp, nonce, sign: createUdunSignature({ body, key: input.config.apiKey, nonce, timestamp }), body };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await (input.fetcher ?? fetch)(`${input.config.gatewayBaseUrl}/mch/address/create`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`UDUN_HTTP_ERROR:${response.status}`);
    const address = parseUdunAddressResponse(await boundedJsonResponse(response, 64_000, "UDUN_ADDRESS_RESPONSE_INVALID"));
    if (address.coinType !== input.mainCoinType) throw new Error("UDUN_ADDRESS_COIN_MISMATCH");
    return address;
  } finally {
    clearTimeout(timeout);
  }
}

export async function testUdunConnectivity(input: {
  config: UdunRuntimeConfig;
  mainCoinType: string;
  tokenCoinType: string;
  fetcher?: typeof fetch;
}) {
  if (!/^\d{1,20}$/.test(input.mainCoinType) || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.tokenCoinType)) {
    throw new Error("UDUN_COIN_MAPPING_INVALID");
  }
  const body = JSON.stringify({ merchantId: input.config.merchantId, showBalance: false });
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("hex");
  const payload = { timestamp, nonce, sign: createUdunSignature({ body, key: input.config.apiKey, nonce, timestamp }), body };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await (input.fetcher ?? fetch)(`${input.config.gatewayBaseUrl}/mch/support-coins`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`UDUN_HTTP_ERROR:${response.status}`);
    const value = await boundedJsonResponse(response, 1_000_000, "UDUN_SUPPORT_COINS_RESPONSE_INVALID") as Record<string, unknown>;
    if (Number(value?.code) !== 200) throw new Error(`UDUN_PROVIDER_ERROR:${String(value?.code ?? "UNKNOWN")}`);
    if (!Array.isArray(value.data) || value.data.length > 10_000) throw new Error("UDUN_SUPPORT_COINS_RESPONSE_INVALID");
    const match = value.data.find((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const coin = candidate as Record<string, unknown>;
      return String(coin.mainCoinType ?? "") === input.mainCoinType
        && String(coin.coinType ?? "") === input.tokenCoinType;
    });
    if (!match || typeof match !== "object" || Array.isArray(match)) throw new Error("UDUN_COIN_MAPPING_NOT_SUPPORTED");
    const coin = match as Record<string, unknown>;
    const decimals = Number(coin.decimals);
    const symbol = String(coin.symbol ?? "").trim().toUpperCase();
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^[A-Z0-9._-]{1,32}$/.test(symbol)) {
      throw new Error("UDUN_SUPPORT_COINS_RESPONSE_INVALID");
    }
    return {
      ok: true as const,
      coin: { decimals, mainCoinType: input.mainCoinType, coinType: input.tokenCoinType, symbol },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeUdunCallbackUrl(raw: string, allowedHosts: readonly string[]) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("UDUN_CALLBACK_URL_INVALID"); }
  const normalizedAllowedHosts = new Set(allowedHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !normalizedAllowedHosts.has(url.hostname.toLowerCase())
    || url.pathname !== "/api/integrations/payments/udun/webhook" || url.search || url.hash) {
    throw new Error("UDUN_CALLBACK_URL_INVALID");
  }
  return url.href;
}

export async function probeUdunCallbackReadiness(input: {
  callbackUrl: string;
  allowedHosts: readonly string[];
  fetcher?: typeof fetch;
}) {
  const callbackUrl = normalizeUdunCallbackUrl(input.callbackUrl, input.allowedHosts);
  const body = JSON.stringify({ probe: true });
  const payload = new URLSearchParams({
    timestamp: Date.now().toString(), nonce: randomBytes(16).toString("hex"), sign: "0".repeat(32), body,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await (input.fetcher ?? fetch)(callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: payload.toString(), redirect: "error", signal: controller.signal,
    });
    let value: unknown = null;
    try { value = await response.json(); } catch { /* readiness requires the structured application response */ }
    const errorCode = value && typeof value === "object" && !Array.isArray(value)
      ? String((value as { error?: { code?: unknown } }).error?.code ?? "") : "";
    if (response.status !== 401 || errorCode !== "WEBHOOK_SIGNATURE_INVALID") {
      throw new Error("UDUN_CALLBACK_PROBE_FAILED");
    }
    return { ok: true as const };
  } finally {
    clearTimeout(timeout);
  }
}
