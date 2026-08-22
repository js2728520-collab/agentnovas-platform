import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateApiRequestPolicy } from "../lib/api-policy.ts";

test("HTTP bootstrap is permanently unavailable and bootstrap is CLI-only", async () => {
  const bootstrap = await readFile(new URL("../app/api/system/bootstrap/route.ts", import.meta.url), "utf8");
  const login = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  const cli = await readFile(new URL("../scripts/bootstrap-internal-admin.mjs", import.meta.url), "utf8");

  assert.match(bootstrap, /status:\s*404/);
  assert.doesNotMatch(bootstrap, /BOOTSTRAP_SECRET|passwordHash|getDb|ensureDatabaseSchema/);
  assert.match(cli, /ALLOW_INTERNAL_BOOTSTRAP/);
  assert.match(cli, /bootstrapInternalAdmin/);
  assert.doesNotMatch(bootstrap, /AN-Admin|Strong-\d/i);
  assert.doesNotMatch(login, /@gmail\.com|@qq\.com|@163\.com/i);
  assert.doesNotMatch(login, /if\s*\(\s*!user[^)]*hostname/);
});

test("bootstrap reaches the inert 404 handler without revealing an origin-specific response", () => {
  const context = evaluateApiRequestPolicy(new Request("https://xm.agentnovas.com/api/system/bootstrap", { method: "POST" }));
  assert.equal(context.policy.requiresSameOrigin, false);
});
