import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Client official-card controls use paper-only routes and distinguish access from runtime state", async () => {
  const experience = await read("apps/client/ui/trading-experience.tsx");
  assert.match(experience, /\/api\/platform-strategies\/\$\{portfolio\.strategyCode\}\/follow/);
  assert.match(experience, /\/api\/platform-strategy-subscriptions\/\$\{portfolio\.runtime\.subscriptionId\}/);
  assert.match(experience, /riskConsent:\s*true/);
  assert.match(experience, /mode:\s*"paper"/);
  assert.match(experience, /不代表 Worker 健康/);
  assert.match(experience, /允许新开仓/);
  assert.doesNotMatch(experience, /ACTIVE:\s*"运行中"/);
  assert.doesNotMatch(experience, /exchangeAccount|\/api\/exchange-accounts|客户交易所/);
});

test("Paper trade route accepts only an owned server-side portfolio scope", async () => {
  const route = await read("app/api/trading-hall/paper/trades/route.client.ts");
  assert.match(route, /portfolioId/);
  assert.match(route, /listOfficialPaperTrades/);
  assert.match(route, /customerId:\s*user\.id/);
  assert.match(route, /portfolioId:/);
});
