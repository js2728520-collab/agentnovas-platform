import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ResearchApiError } from "./research-errors.ts";

const UDUN_HOST_PATTERN = /(?:^|\.)udun\.io$/i;
const CALLBACK_MAX_SKEW_MS = 5 * 60 * 1_000;

export type UdunSignedEnvelope = {
  timestamp: string;
  nonce: string;
  sign: string;
  body: string;
};

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
  const txId = requiredText(source, "txId", 256);
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
};

export function readUdunRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): UdunRuntimeConfig {
  const gateway = environment.UDUN_GATEWAY_BASE_URL?.trim() ?? "";
  const merchantId = environment.UDUN_MERCHANT_ID?.trim() ?? "";
  const apiKey = environment.UDUN_API_KEY?.trim() ?? "";
  const callbackUrl = environment.UDUN_CALLBACK_URL?.trim() ?? "";
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
  const normalizedCallback = new URL(callbackUrl);
  if (normalizedCallback.protocol !== "https:" || normalizedCallback.username || normalizedCallback.password
    || normalizedCallback.pathname !== "/api/integrations/payments/udun/webhook" || normalizedCallback.search || normalizedCallback.hash) {
    throw new ResearchApiError("SERVICE_NOT_CONFIGURED", "优盾回调地址配置无效", 503, { provider: "udun" });
  }
  return { gatewayBaseUrl: normalizeUdunGatewayBaseUrl(gateway), merchantId, apiKey, callbackUrl: normalizedCallback.href };
}

export async function requestUdunDepositAddress(input: {
  config: UdunRuntimeConfig;
  mainCoinType: string;
  alias: string;
  walletId?: string | null;
  fetcher?: typeof fetch;
}) {
  if (!/^\d{1,20}$/.test(input.mainCoinType)) throw new Error("UDUN_MAIN_COIN_TYPE_INVALID");
  const body = JSON.stringify([{
    merchantId: input.config.merchantId,
    coinType: Number(input.mainCoinType),
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
    return parseUdunAddressResponse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function testUdunConnectivity(input: {
  config: UdunRuntimeConfig;
  fetcher?: typeof fetch;
}) {
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
    const value = await response.json() as Record<string, unknown>;
    if (Number(value?.code) !== 200) throw new Error(`UDUN_PROVIDER_ERROR:${String(value?.code ?? "UNKNOWN")}`);
    return { ok: true as const };
  } finally {
    clearTimeout(timeout);
  }
}
