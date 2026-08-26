import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("password reset reads bearer tokens only from a hydration-safe URL fragment", async () => {
  const page = await readFile(new URL("../app/reset-password/page.tsx", import.meta.url), "utf8");
  assert.match(page, /useSyncExternalStore/);
  assert.match(page, /window\.location\.hash/);
  assert.match(page, /replace\(\/\^#\//);
  assert.match(page, /get\("token"\)/);
  assert.match(page, /getServerSnapshot/);
  assert.doesNotMatch(page, /window\.location\.search/);
  assert.match(page, /typeof result\.error === "string"/);
  assert.match(page, /result\.error\?\.message/);
});

test("Client password reset gateway qualifies output-column names and reconverges its ACL", async () => {
  const migration = await readFile(new URL("../postgres/migrations/0072_client_password_reset_gateway_fix.sql", import.meta.url), "utf8");
  assert.match(migration, /UPDATE auth_tokens AS sibling_token/);
  assert.match(migration, /sibling_token\.user_id=target_account_id/);
  assert.match(migration, /UPDATE sessions AS customer_session/);
  assert.doesNotMatch(migration, /WHERE user_id=account_id/);
  assert.match(migration, /SET search_path TO pg_catalog/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION %s TO agentnovas_client_web/);
});
