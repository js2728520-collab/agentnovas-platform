import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("forward migration synchronizes every active permission into existing CLI bootstrap roles", async () => {
  const sql = await readFile(new URL("../postgres/migrations/0037_bootstrap_system_role_permission_sync.sql", import.meta.url), "utf8");
  assert.match(sql, /system_role_identities AS identity/);
  assert.match(sql, /permission\.application_id = identity\.application_id/);
  assert.match(sql, /permission\.status = 'active'/);
  assert.match(sql, /identity\.system_key = 'bootstrap_admin'/);
  assert.match(sql, /ON CONFLICT \(role_id, permission_key\) DO UPDATE/);
  assert.match(sql, /scope = EXCLUDED\.scope/);
  assert.match(sql, /system\.bootstrap_role_permission_synchronized/);
  assert.doesNotMatch(sql, /DELETE\s+FROM|TRUNCATE|DROP\s+TABLE/i);
});
