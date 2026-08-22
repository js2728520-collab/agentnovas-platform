import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("0032 gives customer attribution changes a one-pending maker-checker state machine", async () => {
  const sql = await readFile(new URL("../postgres/migrations/0032_operations_customer_org_hardening.sql", import.meta.url), "utf8");
  assert.match(sql, /customer_attribution_change_requests/);
  assert.match(sql, /customer_attribution_change_decisions/);
  assert.match(sql, /expected_attribution_updated_at/);
  assert.match(sql, /decided_by_user_id<>requested_by_user_id/);
  assert.match(sql, /WHERE status='pending'/);
});
