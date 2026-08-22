import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createPerpetualMarketAdapter } from "../lib/perpetual-market-adapters.ts";
import { createAuthenticatedFeeFetcher, loadResearchExchangeAccount } from "../lib/research-exchange-account.ts";

const now = new Date("2026-08-18T12:34:56.000Z");
const credentials = { apiKey: "api-key", secretKey: "secret-key", passphrase: "passphrase" };

test("revalidates tenant ownership and read-only exchange permissions in the worker", async () => {
  const database = {
    async query(_sql, params) {
      assert.deepEqual(params, ["account-a", "owner-a"]);
      return { rows: [{
        id: "account-a",
        customer_id: "owner-a",
        exchange: "OKX",
        environment: "live",
        encrypted_credential_ref: "ciphertext",
        can_read: 1,
        withdrawal_authorized: 0,
        status: "active",
      }] };
    },
  };
  const account = await loadResearchExchangeAccount(database, {
    accountId: "account-a",
    ownerUserId: "owner-a",
    decrypt: async value => {
      assert.equal(value, "ciphertext");
      return credentials;
    },
  });
  assert.equal(account.exchange, "okx");
  assert.equal(account.credentials.apiKey, "api-key");

  await assert.rejects(loadResearchExchangeAccount({ query: async () => ({ rows: [] }) }, {
    accountId: "other",
    ownerUserId: "owner-a",
    decrypt: async () => credentials,
  }), /租户不匹配/);
});

for (const exchange of ["okx", "binance", "bybit"]) {
  test(`loads the authenticated ${exchange} perpetual fee without exposing credentials`, async () => {
    let captured;
    const payload = exchange === "okx"
      ? { data: [{ maker: "-0.0002", taker: "-0.0005" }] }
      : exchange === "binance"
        ? { makerCommissionRate: "0.0002", takerCommissionRate: "0.0005" }
        : { result: { list: [{ makerFeeRate: "0.0002", takerFeeRate: "0.0005" }] } };
    const fetcher = createAuthenticatedFeeFetcher({
      exchange,
      environment: "live",
      credentials,
      now: () => now,
      fetchImpl: async (url, init) => {
        captured = { url: new URL(String(url)), headers: new Headers(init.headers) };
        return Response.json(payload);
      },
    });
    const fee = await createPerpetualMarketAdapter(exchange, { fetchAuthenticatedJson: fetcher }).getFeeSchedule({ symbol: "BTCUSDT" });
    assert.deepEqual(fee, { makerRate: 0.0002, takerRate: 0.0005, estimated: false, source: `${exchange}_authenticated_fee_api` });
    assert.ok(captured);
    assert.ok(![...captured.headers.values()].some(value => value.includes(credentials.secretKey)));

    if (exchange === "okx") {
      const expected = createHmac("sha256", credentials.secretKey)
        .update(`${now.toISOString()}GET${captured.url.pathname}${captured.url.search}`)
        .digest("base64");
      assert.equal(captured.headers.get("ok-access-sign"), expected);
    } else if (exchange === "binance") {
      const signature = captured.url.searchParams.get("signature");
      captured.url.searchParams.delete("signature");
      assert.equal(signature, createHmac("sha256", credentials.secretKey).update(captured.url.searchParams.toString()).digest("hex"));
    } else {
      const query = captured.url.searchParams.toString();
      const expected = createHmac("sha256", credentials.secretKey)
        .update(`${now.getTime()}${credentials.apiKey}5000${query}`)
        .digest("hex");
      assert.equal(captured.headers.get("x-bapi-sign"), expected);
    }
  });
}

test("uses a clearly estimated conservative fee when the authenticated endpoint fails", async () => {
  const fee = await createPerpetualMarketAdapter("binance", {
    fetchAuthenticatedJson: async () => { throw new Error("unavailable"); },
  }).getFeeSchedule({ symbol: "BTCUSDT" });
  assert.equal(fee.estimated, true);
  assert.equal(fee.source, "administrator_conservative_default_after_fee_api_failure");
});

test("never sends sandbox credentials or credentials to a non-official fee URL", async () => {
  assert.equal(createAuthenticatedFeeFetcher({ exchange: "okx", environment: "demo", credentials }), undefined);
  const fetcher = createAuthenticatedFeeFetcher({ exchange: "okx", environment: "live", credentials });
  await assert.rejects(fetcher("https://example.com/api/v5/account/trade-fee"), /非官方/);
});
