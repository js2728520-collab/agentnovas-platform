import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("internal login creates a restricted primary session that can enter enrollment", async () => {
  const login = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");
  assert.match(login, /user_mfa_totp_credentials/);
  assert.match(login, /mfaEnrollmentRequired/);
  assert.match(login, /mfaLevel: "primary"/);
  assert.match(login, /mfaRequired/);
});
test("the MFA endpoint is rate limited and atomically upgrades the same session", async () => {
  const verify = await readFile(new URL("../app/api/auth/mfa/verify/route.ts", import.meta.url), "utf8");
  assert.match(verify, /requirePrimarySession/);
  assert.match(verify, /consumeAuthRateLimit/);
  assert.match(verify, /verifyAndConsumeMfa/);
  assert.match(verify, /mfaVerifiedAt/);
  assert.match(verify, /eq\(sessions\.id, current\.session\.id\)/);
});

test("sensitive RBAC permissions require MFA completed within fifteen minutes", async () => {
  const access = await readFile(new URL("../lib/access-control.ts", import.meta.url), "utf8");
  assert.match(access, /definition\.sensitive/);
  assert.match(access, /current\.recentMfa/);
  assert.match(access, /RECENT_MFA_REQUIRED/);
  assert.match(access, /maxAgeSeconds: 900/);
});
