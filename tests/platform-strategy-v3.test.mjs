import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePlatformStrategy, PLATFORM_AI_STRATEGIES } from "../packages/domain/src/platform-ai-strategies.ts";
import {
  evaluateConvertedPlatformStrategy,
  platformStrategyDslV3,
} from "../packages/domain/src/platform-strategy-v3.ts";

function generator(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function candles(seed, scenario) {
  const random = generator(seed);
  let close = 100;
  const rows = [];
  for (let index = 0; index < 100; index += 1) {
    const open = close;
    const drift = scenario === 0 ? 0.0008 : scenario === 1 ? 0.00015 : scenario === 2 ? -0.00015 : 0;
    const oscillation = Math.sin((index + seed % 13) / 4) * (scenario === 3 ? 0.004 : 0.0015);
    const shock = (random() - 0.5) * (scenario === 2 ? 0.018 : 0.009);
    close = Math.max(5, open * (1 + drift + oscillation + shock));
    if (index === 99 && seed % 7 === 0) close *= 1.02;
    if (index === 99 && seed % 11 === 0) close *= 0.975;
    const spread = 0.001 + random() * 0.008;
    rows.push({
      openTime: index * 3_600_000,
      closeTime: (index + 1) * 3_600_000 - 1,
      open,
      high: Math.max(open, close) * (1 + spread),
      low: Math.min(open, close) * (1 - spread),
      close,
      volume: (80 + random() * 50) * (index === 99 && seed % 5 === 0 ? 2.5 : 1),
    });
  }
  return rows;
}

for (const code of Object.keys(PLATFORM_AI_STRATEGIES)) {
  test(`${code} V3 conversion matches the legacy signal contract on golden market paths`, () => {
    const definition = PLATFORM_AI_STRATEGIES[code];
    const dsl = platformStrategyDslV3(code, definition.symbols[0]);
    const actions = new Set();
    for (let sample = 1; sample <= 900; sample += 1) {
      const rows = candles(sample * 97, sample % 4);
      for (const hasOpenPosition of [false, true]) {
        const legacy = evaluatePlatformStrategy(definition, definition.symbols[0], rows, hasOpenPosition).action;
        const converted = evaluateConvertedPlatformStrategy(dsl, rows, hasOpenPosition);
        assert.equal(converted, legacy, `sample=${sample}, hasOpenPosition=${hasOpenPosition}`);
        actions.add(legacy);
      }
    }
    assert.ok(actions.has("hold"));
    assert.ok(actions.has("exit"));
    assert.ok(actions.has("enter"));
  });
}

test("platform conversion rejects symbols outside the immutable platform product", () => {
  assert.throws(() => platformStrategyDslV3("ai_conservative", "SOLUSDT"), /不支持/);
});
