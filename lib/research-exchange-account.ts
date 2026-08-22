import type { Pool, PoolClient } from "pg";

import type { ExchangeCredential } from "./exchange-credentials.ts";
import type { PerpetualExchange } from "./perpetual-market-adapters.ts";

type Queryable = Pick<Pool | PoolClient, "query">;
type FetchLike = typeof fetch;

type ExchangeAccountRow = {
  id: string;
  customer_id: string;
  exchange: string;
  environment: "demo" | "live";
  encrypted_credential_ref: string;
  can_read: number | boolean;
  withdrawal_authorized: number | boolean;
  status: string;
};

const encoder = new TextEncoder();

function normalizedExchange(value: string): PerpetualExchange | null {
  const normalized = value.trim().toLowerCase();
  return normalized === "okx" || normalized === "binance" || normalized === "bybit" ? normalized : null;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function responseJson(response: Response, exchange: PerpetualExchange) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${exchange} 费率接口返回 HTTP ${response.status}`);
  return payload;
}

export async function loadResearchExchangeAccount(database: Queryable, input: {
  accountId: string;
  ownerUserId: string;
  decrypt?: (value: string) => Promise<ExchangeCredential>;
}) {
  const result = await database.query<ExchangeAccountRow>(`
    SELECT id, customer_id, exchange, environment, encrypted_credential_ref,
           can_read, withdrawal_authorized, status
    FROM exchange_accounts
    WHERE id = $1 AND customer_id = $2
    LIMIT 1
  `, [input.accountId, input.ownerUserId]);
  const row = result.rows[0];
  const exchange = row ? normalizedExchange(row.exchange) : null;
  if (!row || !exchange) throw new Error("交易所账户不存在、租户不匹配或不支持永续研究");
  if (row.status !== "active" || !row.can_read || row.withdrawal_authorized) {
    throw new Error("交易所账户必须保持激活、只读且不包含提现权限");
  }
  const decrypt = input.decrypt ?? (await import("./exchange-credentials.ts")).decryptExchangeCredential;
  const credentials = await decrypt(row.encrypted_credential_ref);
  if (!credentials.apiKey?.trim() || !credentials.secretKey?.trim()) throw new Error("交易所读取凭证不完整");
  if (exchange === "okx" && !credentials.passphrase?.trim()) throw new Error("OKX 读取凭证缺少 Passphrase");
  return { id: row.id, exchange, environment: row.environment, credentials };
}

export function createAuthenticatedFeeFetcher(input: {
  exchange: PerpetualExchange;
  environment: "demo" | "live";
  credentials: ExchangeCredential;
  fetchImpl?: FetchLike;
  now?: () => Date;
}) {
  // Sandbox fee tiers do not represent the user's production account.
  if (input.environment !== "live") return undefined;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());

  return async (rawUrl: string) => {
    const url = new URL(rawUrl);
    const expectedHosts: Record<PerpetualExchange, string> = {
      okx: "www.okx.com",
      binance: "fapi.binance.com",
      bybit: "api.bybit.com",
    };
    const expectedPaths: Record<PerpetualExchange, string> = {
      okx: "/api/v5/account/trade-fee",
      binance: "/fapi/v1/commissionRate",
      bybit: "/v5/account/fee-rate",
    };
    if (url.protocol !== "https:" || url.hostname !== expectedHosts[input.exchange] || url.pathname !== expectedPaths[input.exchange]) {
      throw new Error("拒绝向非官方费率端点发送交易所凭证");
    }

    const headers = new Headers({ accept: "application/json" });
    if (input.exchange === "okx") {
      if (!input.credentials.passphrase) throw new Error("OKX Passphrase 缺失");
      const timestamp = now().toISOString();
      const signature = bytesToBase64(await hmac(`${timestamp}GET${url.pathname}${url.search}`, input.credentials.secretKey));
      headers.set("OK-ACCESS-KEY", input.credentials.apiKey);
      headers.set("OK-ACCESS-SIGN", signature);
      headers.set("OK-ACCESS-TIMESTAMP", timestamp);
      headers.set("OK-ACCESS-PASSPHRASE", input.credentials.passphrase);
    } else if (input.exchange === "binance") {
      url.searchParams.set("recvWindow", "5000");
      url.searchParams.set("timestamp", String(now().getTime()));
      url.searchParams.set("signature", bytesToHex(await hmac(url.searchParams.toString(), input.credentials.secretKey)));
      headers.set("X-MBX-APIKEY", input.credentials.apiKey);
    } else {
      const timestamp = String(now().getTime());
      const recvWindow = "5000";
      const query = url.searchParams.toString();
      const signature = bytesToHex(await hmac(`${timestamp}${input.credentials.apiKey}${recvWindow}${query}`, input.credentials.secretKey));
      headers.set("X-BAPI-API-KEY", input.credentials.apiKey);
      headers.set("X-BAPI-SIGN", signature);
      headers.set("X-BAPI-SIGN-TYPE", "2");
      headers.set("X-BAPI-TIMESTAMP", timestamp);
      headers.set("X-BAPI-RECV-WINDOW", recvWindow);
    }

    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return responseJson(response, input.exchange);
  };
}
