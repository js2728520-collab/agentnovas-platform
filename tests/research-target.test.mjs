import assert from "node:assert/strict";
import test from "node:test";

import { parseStrategyResearchTarget } from "../lib/research-target.ts";

test("accepts and normalizes an explicit single-instrument perpetual target", () => {
  assert.deepEqual(parseStrategyResearchTarget({
    target: {
      instrumentId: "btc-usdt-swap",
      symbol: "btc/usdt",
      timeframe: "4h",
      direction: "both",
    },
    brief: {},
  }), {
    instrumentId: "BTC-USDT-SWAP",
    symbol: "BTCUSDT",
    timeframe: "4h",
    direction: "both",
    source: "target",
  });
});

test("supports legacy brief fields without inventing missing target values", () => {
  assert.deepEqual(parseStrategyResearchTarget({
    brief: { symbol: "ethusdt", timeframe: "15m", direction: "short_only" },
  }), {
    instrumentId: "ETHUSDT",
    symbol: "ETHUSDT",
    timeframe: "15m",
    direction: "short_only",
    source: "legacy_brief",
  });

  assert.throws(
    () => parseStrategyResearchTarget({ brief: { symbol: "BTCUSDT", timeframe: "1h" } }),
    (error) => error?.code === "VALIDATION_ERROR"
      && error?.status === 422
      && error?.details?.fields?.includes("direction"),
  );
});

test("rejects malformed, unsupported, and overly broad research targets", () => {
  assert.throws(
    () => parseStrategyResearchTarget({
      target: {
        instrumentId: "BTC-USDT-SWAP",
        symbol: "BTCUSDT",
        timeframe: "30m",
        direction: "long_only",
      },
      brief: {},
    }),
    /周期/,
  );
  assert.throws(
    () => parseStrategyResearchTarget({
      target: {
        instrumentId: "BTC-USDT-SWAP",
        symbol: "BTCUSD",
        timeframe: "1h",
        direction: "long_only",
      },
      brief: {},
    }),
    /USDT/,
  );
  assert.throws(
    () => parseStrategyResearchTarget({
      target: {
        instrumentId: "BTC-USDT-SWAP",
        symbol: "BTCUSDT",
        timeframe: "1h",
        direction: "long_only",
        symbols: ["BTCUSDT", "ETHUSDT"],
      },
      brief: {},
    }),
    /未知字段/,
  );
});
