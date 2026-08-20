import assert from "node:assert/strict";
import test from "node:test";

import {
  betaPaperCapitalUsdt,
  commercialBetaPlans,
  membershipOrderStatuses,
  performanceFeeCurrency,
  performanceFeeCycle,
  performanceFeeStatementStatuses,
  platformDemoProviders,
} from "../packages/contracts/src/commercial-beta.ts";

test("publishes the four immutable commercial Beta plan snapshots", () => {
  assert.deepEqual(commercialBetaPlans, [
    { code: "monthly_v1", name: "月卡", priceUsd: "28.00", priceCurrency: "USD", durationDays: 30, aiCredits: 1_000, performanceFeeRate: "0.20", isLifetime: false },
    { code: "quarterly_v1", name: "季卡", priceUsd: "58.00", priceCurrency: "USD", durationDays: 90, aiCredits: 3_000, performanceFeeRate: "0.20", isLifetime: false },
    { code: "annual_v1", name: "年卡", priceUsd: "198.00", priceCurrency: "USD", durationDays: 365, aiCredits: 12_000, performanceFeeRate: "0.20", isLifetime: false },
    { code: "lifetime_v1", name: "终身会员", priceUsd: "588.00", priceCurrency: "USD", durationDays: null, aiCredits: 36_000, performanceFeeRate: "0.16", isLifetime: true },
  ]);
});

test("keeps paper settlement and platform Demo evidence separate", () => {
  assert.equal(betaPaperCapitalUsdt, "10000.00");
  assert.equal(performanceFeeCycle.timezone, "UTC");
  assert.equal(performanceFeeCycle.cadence, "WEEKLY");
  assert.equal(performanceFeeCurrency, "USDT");
  assert.deepEqual(platformDemoProviders, ["OKX_DEMO", "BINANCE_SPOT_TESTNET", "BYBIT_DEMO"]);
  assert.ok(performanceFeeStatementStatuses.includes("CLOSED_NO_FEE"));
  assert.equal(performanceFeeStatementStatuses.includes("VOID"), false);
});

test("public commercial status enums contain only states an API DTO can emit", () => {
  assert.deepEqual(membershipOrderStatuses, [
    "AWAITING_EVIDENCE",
    "SUBMITTED",
    "REJECTED",
    "ACTIVATED",
    "CANCELLED",
  ]);
  assert.deepEqual(performanceFeeStatementStatuses, [
    "SUBMITTED",
    "APPROVED",
    "REJECTED",
    "INVOICED",
    "PAID",
    "CLOSED_NO_FEE",
  ]);
});

test("public contracts do not promise Demo account or receipt DTOs before their APIs exist", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../packages/contracts/src/commercial-beta.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /export type PlatformDemoExecutionReceipt/);
  assert.doesNotMatch(source, /export type MaintenanceDemoAccount/);
});
