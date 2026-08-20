import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveCommercialOfficialPaperScope } from "../lib/commercial-portfolio-scope.ts";

const membershipId = "membership-1";
const customerId = "customer-1";
const period = {
  start: "2026-08-10T00:00:00.000Z",
  end: "2026-08-17T00:00:00.000Z",
};
const strategies = ["ai_conservative", "ai_balanced", "ai_aggressive"].map(
  (strategyCode) => ({
    strategyCode,
    portfolioId: `official-paper:${membershipId}:${strategyCode}`,
    realizedGrossPnlUsdt: "10.000000000000",
    realizedNetPnlUsdt: "9.000000000000",
    feesUsdt: "1.000000000000",
    cumulativeNetPnl: "19.000000000000",
    priorNetPnl: "10.000000000000",
  }),
);

function aggregate(overrides = {}) {
  return {
    customerId,
    membershipId,
    scopeKey: `official-three:${membershipId}`,
    scopeVersion: "official-paper-closed-sells-v1",
    period,
    periodStart: period.start,
    periodEnd: period.end,
    weekNetPnl: "27.000000000000",
    cumulativeNetPnl: "57.000000000000",
    priorNetPnl: "30.000000000000",
    realizedGrossPnlUsdt: "30.000000000000",
    realizedNetPnlUsdt: "27.000000000000",
    feesUsdt: "3.000000000000",
    strategies,
    ...overrides,
  };
}

test("commercial scope resolves the server-owned official three-card aggregate", async () => {
  const result = await resolveCommercialOfficialPaperScope(
    {},
    { membershipId, customerId, asOf: new Date("2026-08-20T12:00:00Z") },
    { aggregate: async () => aggregate() },
  );

  assert.equal(result.weekNetPnl, "27.000000000000");
  assert.equal(result.priorNetPnl, "30.000000000000");
  assert.deepEqual(
    result.strategies.map(({ strategyCode }) => strategyCode),
    ["ai_conservative", "ai_balanced", "ai_aggressive"],
  );
  assert.equal("strategyIds" in result, false);
});

test("commercial scope fails closed on ownership, period, or three-card drift", async () => {
  const cases = [
    aggregate({ customerId: "another-customer" }),
    aggregate({ period: { ...period, end: "2026-08-18T00:00:00.000Z" } }),
    aggregate({ strategies: strategies.slice(0, 2) }),
  ];

  for (const value of cases) {
    await assert.rejects(
      resolveCommercialOfficialPaperScope(
        {},
        { membershipId, customerId, asOf: new Date("2026-08-20T12:00:00Z") },
        { aggregate: async () => value },
      ),
      (error) =>
        error.code === "OFFICIAL_PORTFOLIO_SCOPE_INVALID" &&
        error.status === 503,
    );
  }
});

test("production performance settlement has no legacy PnL or caller strategy scope", async () => {
  const service = await readFile(
    new URL("../lib/performance-fee-service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(service, /commercial_closed_paper_pnl/);
  assert.doesNotMatch(service, /strategyIds/);
  assert.match(service, /resolveCommercialOfficialPaperScope/);
  assert.match(service, /priorNetPnl/);
});
