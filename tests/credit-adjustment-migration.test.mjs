import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("0031 defines a one-pending maker-checker credit workflow", async () => {
  const sql = await readFile(new URL("../postgres/migrations/0031_credit_adjustment_workflow.sql", import.meta.url), "utf8");
  assert.match(sql, /ai_credit_adjustment_requests/);
  assert.match(sql, /ai_credit_adjustment_decisions/);
  assert.match(sql, /decided_by_user_id<>requested_by_user_id/);
  assert.match(sql, /WHERE status='pending'/);
  assert.match(sql, /amount_delta<>0/);
  assert.match(sql, /ops\.credits\.adjust/);
  assert.match(sql, /ops\.credits\.approve/);
});
