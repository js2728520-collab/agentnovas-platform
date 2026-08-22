import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Operations data center uses scoped commercial Paper metrics and excludes legacy customer trading data", async () => {
  const route = await readFile(new URL("../app/api/data-center/route.ts", import.meta.url), "utf8");
  const ui = await readFile(new URL("../apps/operations/ui/data-center-workspace.tsx", import.meta.url), "utf8");
  assert.match(route, /commercialCustomerScopePredicate/);
  assert.match(route, /official_paper_fill_receipts/);
  assert.match(route, /commercial_membership_orders/);
  assert.doesNotMatch(route, /exchange_accounts|registrationIp|withdrawal|funding_usdt|FROM trades/i);
  assert.match(ui, /不含平台 Demo 账户/);
  assert.match(ui, /客户交易所账户、真实交易或完整 PII/);
});
