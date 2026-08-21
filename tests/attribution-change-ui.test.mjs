import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("customer attribution change is visible in detail and unified approvals without self-review", async () => {
  const customers = await readFile(new URL("../apps/operations/ui/customers-workspace.tsx", import.meta.url), "utf8");
  const approvals = await readFile(new URL("../apps/operations/ui/approvals-workspace.tsx", import.meta.url), "utf8");
  const submit = await readFile(new URL("../app/api/operations/attribution-changes/route.ts", import.meta.url), "utf8");
  const decision = await readFile(new URL("../app/api/operations/attribution-changes/[id]/decision/route.ts", import.meta.url), "utf8");
  assert.match(customers, /经理 → 主管 → 员工/);
  assert.match(customers, /当前归属尚未改变/);
  assert.match(approvals, /客户归属调整/);
  assert.match(approvals, /禁止自审/);
  assert.match(submit, /submitAttributionChange/);
  assert.match(decision, /decideAttributionChange/);
});
