import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Operations customer detail aggregates commercial state and uses audited endpoints", async () => {
  const detail = await read("app/api/operations/customers/[id]/route.ts");
  const status = await read("app/api/operations/customers/[id]/status/route.ts");
  const notes = await read("app/api/operations/customers/[id]/notes/route.ts");
  const list = await read("app/api/operations/customers/route.ts");
  const ui = await read("apps/operations/ui/customers-workspace.tsx");
  assert.match(detail, /commercial_membership_orders/);
  assert.match(detail, /performance_fee_statements/);
  assert.match(detail, /official_paper_portfolios/);
  assert.match(detail, /ai_credit_accounts/);
  assert.match(status, /changeOperationsCustomerStatus/);
  assert.match(notes, /customer_handover_notes/);
  assert.match(list, /commercialCustomerScopePredicate/);
  assert.match(list, /encodeCommercialCursor/);
  assert.match(ui, /window\.history\.replaceState/);
  assert.match(ui, /\/api\/operations\/customers\/\$\{selected\.customerId\}/);
  assert.match(ui, /备注历史/);
  assert.match(ui, /模拟组合/);
  assert.match(ui, /会员与 Credits/);
});
