import assert from "node:assert/strict";
import test from "node:test";

import {
  assessPerpetualDataQuality,
  createPerpetualMarketAdapter,
  normalizeCandleBatch,
  normalizeFundingBatch,
} from "../lib/perpetual-market-adapters.ts";

const now = 1_800_000_000_000;

test("normalizes reversed OKX and Bybit candles and removes duplicate timestamps", () => {
  const okx = normalizeCandleBatch("okx", {
    code: "0",
    data: [
      ["300", "3", "4", "2", "3.5", "30", "0", "0", "1"],
      ["200", "2", "3", "1", "2.5", "20", "0", "0", "1"],
      ["200", "2", "3", "1", "2.5", "20", "0", "0", "1"],
    ],
  }, now, 100);
  const bybit = normalizeCandleBatch("bybit", {
    retCode: 0,
    result: { list: [
      ["300", "3", "4", "2", "3.5", "30", "0"],
      ["200", "2", "3", "1", "2.5", "20", "0"],
    ] },
  }, now, 100);

  assert.deepEqual(okx.items.map((item) => item.openTime), [200, 300]);
  assert.equal(okx.duplicateCount, 1);
  assert.equal(okx.reversedInput, true);
  assert.deepEqual(bybit.items.map((item) => item.openTime), [200, 300]);
  assert.equal(bybit.reversedInput, true);
});

test("normalizes Binance candles and filters unfinished or malformed rows", () => {
  const batch = normalizeCandleBatch("binance", [
    [100, "1", "2", "0.5", "1.5", "10", 199],
    [200, "2", "3", "1", "2.5", "20", now + 1],
    [300, "bad", "4", "2", "3.5", "30", 399],
  ], now, 100);

  assert.deepEqual(batch.items.map((item) => item.openTime), [100]);
  assert.equal(batch.incompleteCount, 1);
  assert.equal(batch.invalidCount, 1);
});

test("paginates all three exchanges with official perpetual endpoints", async () => {
  const cases = [
    {
      exchange: "okx",
      expectedPath: "/api/v5/market/history-candles",
      pages: [
        { code: "0", data: [["300", "3", "4", "2", "3.5", "30", "0", "0", "1"], ["200", "2", "3", "1", "2.5", "20", "0", "0", "1"]] },
        { code: "0", data: [["200", "2", "3", "1", "2.5", "20", "0", "0", "1"], ["100", "1", "2", "0.5", "1.5", "10", "0", "0", "1"]] },
      ],
    },
    {
      exchange: "binance",
      expectedPath: "/fapi/v1/klines",
      pages: [
        [[200, "2", "3", "1", "2.5", "20", 299], [300, "3", "4", "2", "3.5", "30", 399]],
        [[100, "1", "2", "0.5", "1.5", "10", 199], [200, "2", "3", "1", "2.5", "20", 299]],
      ],
    },
    {
      exchange: "bybit",
      expectedPath: "/v5/market/kline",
      pages: [
        { retCode: 0, result: { list: [["300", "3", "4", "2", "3.5", "30", "0"], ["200", "2", "3", "1", "2.5", "20", "0"]] } },
        { retCode: 0, result: { list: [["200", "2", "3", "1", "2.5", "20", "0"], ["100", "1", "2", "0.5", "1.5", "10", "0"]] } },
      ],
    },
  ];

  for (const fixture of cases) {
    const urls = [];
    const adapter = createPerpetualMarketAdapter(fixture.exchange, {
      now: () => now,
      fetchJson: async (url) => {
        urls.push(url);
        return fixture.pages[Math.min(urls.length - 1, fixture.pages.length - 1)];
      },
    });
    const result = await adapter.getCandles({ symbol: "BTCUSDT", timeframe: "1h", limit: 3 });
    assert.deepEqual(result.items.map((item) => item.openTime), [100, 200, 300], fixture.exchange);
    assert.equal(urls.length, 2, fixture.exchange);
    assert.ok(new URL(urls[0]).pathname.endsWith(fixture.expectedPath), fixture.exchange);
  }
});

test("normalizes funding direction inputs and marks critical gaps as not verifiable", () => {
  const funding = normalizeFundingBatch("binance", [
    { fundingTime: 100, fundingRate: "0.0001" },
    { fundingTime: 200, fundingRate: "-0.0002" },
  ]);
  const candles = {
    items: [
      { openTime: 0, closeTime: 99, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: 100, closeTime: 199, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: 300, closeTime: 399, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ],
    duplicateCount: 1,
    incompleteCount: 0,
    invalidCount: 0,
    reversedInput: false,
  };
  const quality = assessPerpetualDataQuality({
    candles,
    funding,
    timeframe: "1h",
    expectedFundingIntervalHours: 8,
    feeEstimated: true,
  });

  assert.equal(funding.items[0].rate, 0.0001);
  assert.equal(quality.candleGapCount, 1);
  assert.equal(quality.feeEstimated, true);
  assert.equal(quality.isVerifiable, false);
});

test("uses conservative fees when authenticated fee access is unavailable", async () => {
  const adapter = createPerpetualMarketAdapter("bybit", {
    now: () => now,
    fetchJson: async () => ({ retCode: 0, result: { list: [] } }),
  });
  const fee = await adapter.getFeeSchedule({ symbol: "BTCUSDT" });

  assert.equal(fee.estimated, true);
  assert.ok(fee.takerRate >= fee.makerRate);
  assert.ok(fee.takerRate > 0);
});

test("lists only live USDT perpetual instruments with normalized trading rules", async () => {
  const fixtures = {
    okx: [{
      code: "0",
      data: [
        { instId: "BTC-USDT-SWAP", settleCcy: "USDT", state: "live", tickSz: "0.1", lotSz: "0.001" },
        { instId: "ETH-USD-SWAP", settleCcy: "USD", state: "live", tickSz: "0.1", lotSz: "0.01" },
      ],
    }],
    binance: [{
      symbols: [
        { symbol: "BTCUSDT", pair: "BTCUSDT", quoteAsset: "USDT", marginAsset: "USDT", status: "TRADING", contractType: "PERPETUAL", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.1" }, { filterType: "LOT_SIZE", stepSize: "0.001" }] },
        { symbol: "ETHUSDT_250926", quoteAsset: "USDT", status: "TRADING", contractType: "CURRENT_QUARTER", filters: [] },
      ],
    }],
    bybit: [
      { retCode: 0, result: { nextPageCursor: "next", list: [{ symbol: "BTCUSDT", quoteCoin: "USDT", settleCoin: "USDT", status: "Trading", contractType: "LinearPerpetual", fundingInterval: "480", priceFilter: { tickSize: "0.1" }, lotSizeFilter: { qtyStep: "0.001" } }] } },
      { retCode: 0, result: { nextPageCursor: "", list: [{ symbol: "ETHUSDT", quoteCoin: "USDT", settleCoin: "USDT", status: "Trading", contractType: "LinearPerpetual", fundingInterval: "240", priceFilter: { tickSize: "0.01" }, lotSizeFilter: { qtyStep: "0.01" } }] } },
    ],
  };

  for (const exchange of ["okx", "binance", "bybit"]) {
    const urls = [];
    const adapter = createPerpetualMarketAdapter(exchange, {
      fetchJson: async (url) => {
        urls.push(url);
        return fixtures[exchange][Math.min(urls.length - 1, fixtures[exchange].length - 1)];
      },
    });
    const instruments = await adapter.listInstruments({ quote: "USDT" });
    assert.ok(instruments.length >= 1, exchange);
    assert.ok(instruments.every((item) => item.quoteAsset === "USDT" && item.status === "live"), exchange);
    assert.ok(instruments.every((item) => item.tickSize > 0 && item.lotSize > 0), exchange);
    if (exchange === "bybit") {
      assert.deepEqual(instruments.map((item) => item.symbol), ["BTCUSDT", "ETHUSDT"]);
      assert.equal(new URL(urls[1]).searchParams.get("cursor"), "next");
    } else {
      assert.equal(urls.length, 1, exchange);
    }
  }
});
