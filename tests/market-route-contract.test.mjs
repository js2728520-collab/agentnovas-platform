import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { marketInstruments } from "../lib/market-instruments.ts";

test("keeps reusable market data outside the Next route module", () => {
  const routeSource = readFileSync(new URL("../app/api/market/instruments/route.client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /export\s+(?:const|function|class|type|interface)\s+(?!GET\b)/);
  assert.ok(marketInstruments.length > 0);
  assert.equal(marketInstruments.find((item) => item.symbol === "BTCUSD")?.providerSymbol, "BTCUSDT");
});
