import assert from "node:assert/strict";
import test from "node:test";

import { officialTradingHallStrategies } from "../packages/contracts/src/trading-hall.ts";
import { PLATFORM_AI_STRATEGIES } from "../lib/platform-ai-strategies.ts";
import { platformStrategyDslV3 } from "../lib/platform-strategy-v3.ts";
import { evaluateStrategyRuntimeCycle } from "../lib/strategy-runtime-engine.ts";

function entryCandles() {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    openTime: index * 3_600_000,
    closeTime: (index + 1) * 3_600_000 - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
  rows[29] = { ...rows[29], high: 112, close: 111 };
  return rows;
}

test("official strategy runtime specifications use the trading-hall spot contract verbatim", () => {
  for (const official of officialTradingHallStrategies) {
    const definition = PLATFORM_AI_STRATEGIES[official.code];
    assert.equal(definition.product, "spot_usdt");
    assert.deepEqual(definition.symbols, [...official.symbols]);
    assert.deepEqual(definition.risk, official.risk);

    for (const symbol of official.symbols) {
      const specification = platformStrategyDslV3(official.code, symbol);
      assert.equal(specification.schemaVersion, "official_spot_v1");
      assert.equal(specification.product, "spot_usdt");
      assert.equal(specification.direction, "long_only");
      assert.deepEqual(specification.risk, official.risk);
      assert.equal(specification.execution.leverageEnabled, false);
      assert.equal(specification.execution.shortSellingEnabled, false);
      assert.equal(specification.execution.fundingEnabled, false);
      assert.equal("short" in specification.legs, false);
      assert.equal("marginMode" in specification, false);
      assert.equal("leverage" in specification, false);
    }
  }
});

test("official spot specifications flow through runtime without short, leverage, or funding intents", () => {
  const specification = platformStrategyDslV3("ai_conservative", "BTCUSDT");
  const result = evaluateStrategyRuntimeCycle({
    deploymentId: "official-deployment",
    strategyVersionId: "official-version",
    dsl: specification,
    candles: entryCandles(),
    mode: "paper",
    position: null,
    riskState: { drawdownPct: 0, dailyLossPct: 0, consecutiveLosses: 0, halted: false },
  });

  assert.equal(result.specification.product, "spot_usdt");
  assert.notEqual(result.decision.action, "enter_short");
  assert.notEqual(result.orderIntent?.side, "short");
  assert.equal(JSON.stringify(result.orderIntent).includes("funding"), false);
  assert.equal(JSON.stringify(result.orderIntent).includes("leverage"), false);
});
