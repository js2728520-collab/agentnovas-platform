import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("requires an explicit bootstrap secret and contains no personal login backdoor", async () => {
  const bootstrap = await readFile(new URL("../app/api/system/bootstrap/route.ts", import.meta.url), "utf8");
  const login = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");

  assert.match(bootstrap, /runtimeSetting\("BOOTSTRAP_SECRET"\)/);
  assert.doesNotMatch(bootstrap, /bootstrapSecret\s*=\s*runtimeSetting\([^\n]+\)\s*\|\|/);
  assert.doesNotMatch(bootstrap, /AN-Admin|Strong-\d/i);
  assert.doesNotMatch(login, /@gmail\.com|@qq\.com|@163\.com/i);
  assert.doesNotMatch(login, /if\s*\(\s*!user[^)]*hostname/);
});
