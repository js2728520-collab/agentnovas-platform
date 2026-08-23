import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("internal login keeps the restricted MFA path behind an explicit runtime enforcement switch", async () => {
  const login = await readFile(new URL("../app/api/auth/login/route.shared.ts", import.meta.url), "utf8");
  const mfa = await readFile(new URL("../lib/mfa.ts", import.meta.url), "utf8");
  assert.match(login, /user_mfa_totp_credentials/);
  assert.match(login, /mfaEnrollmentRequired/);
  assert.match(login, /mfaLevel: mfaRequired \? "primary" : "none"/);
  assert.match(login, /mfaRequired/);
  assert.match(mfa, /MFA_ENFORCEMENT_ENABLED/);
  assert.match(mfa, /mfaEnforcementEnabled/);
  assert.match(mfa, /required: internal \|\| enrolled/);
  assert.match(mfa, /enrollmentRequired: internal && !enrolled/);
});
test("the MFA endpoint is rate limited and atomically upgrades the same session", async () => {
  const verify = await readFile(new URL("../app/api/auth/mfa/verify/route.shared.ts", import.meta.url), "utf8");
  assert.match(verify, /requirePrimarySession/);
  assert.match(verify, /consumeAuthRateLimit/);
  assert.match(verify, /verifyAndConsumeMfa/);
  assert.match(verify, /mfaVerifiedAt/);
  assert.match(verify, /eq\(sessions\.id, current\.session\.id\)/);
});

test("sensitive RBAC permissions require MFA completed within fifteen minutes", async () => {
  const access = await readFile(new URL("../lib/access-control.ts", import.meta.url), "utf8");
  assert.match(access, /definition\.sensitive/);
  assert.match(access, /mfaEnforcementEnabled/);
  assert.match(access, /current\.recentMfa/);
  assert.match(access, /RECENT_MFA_REQUIRED/);
  assert.match(access, /maxAgeSeconds: 900/);
});

test("internal users can rotate recovery codes only from a recent MFA session", async () => {
  const route = await readFile(new URL("../app/api/auth/mfa/recovery-codes/route.shared.ts", import.meta.url), "utf8");
  const session = await readFile(new URL("../lib/session.ts", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../packages/ui/src/internal-account-security.tsx", import.meta.url), "utf8");
  assert.match(route, /requireRecentMfaSession/);
  assert.match(route, /rotateMfaRecoveryCodes/);
  assert.match(route, /getMfaRecoveryStatus/);
  assert.match(route, /enforcementEnabled: mfaEnforcementEnabled\(\)/);
  assert.match(session, /RECENT_MFA_REQUIRED/);
  assert.match(workspace, /恢复码仅显示这一次/);
  assert.match(workspace, /\/api\/auth\/mfa\/recovery-codes/);
  assert.doesNotMatch(workspace, /localStorage|sessionStorage/);
});
