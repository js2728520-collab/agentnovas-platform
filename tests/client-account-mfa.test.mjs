import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mfaLoginRequirement } from "../lib/mfa.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Client MFA is optional until enrolled and mandatory after enrollment", () => {
  assert.deepEqual(mfaLoginRequirement("client", false), {
    required: false,
    enrollmentRequired: false,
  });
  assert.deepEqual(mfaLoginRequirement("client", true), {
    required: true,
    enrollmentRequired: false,
  });
  assert.deepEqual(mfaLoginRequirement("operations", false), {
    required: true,
    enrollmentRequired: true,
  });
  assert.deepEqual(mfaLoginRequirement("maintenance", true), {
    required: true,
    enrollmentRequired: false,
  });
});

test("Client pending MFA sessions cannot use normal APIs before verification", async () => {
  const session = await read("lib/session.ts");
  const login = await read("app/api/auth/login/route.shared.ts");
  const verify = await read("app/api/auth/mfa/verify/route.shared.ts");
  const confirm = await read("app/api/auth/mfa/enroll/confirm/route.shared.ts");
  const appLogin = await read("packages/ui/src/app-login.tsx");
  assert.match(login, /mfaLoginRequirement/);
  assert.match(login, /mfaLevel: mfaRequired \? "primary" : "none"/);
  assert.match(session, /clientPrimaryMfaPending/);
  assert.match(session, /clientSessionIdentity/);
  assert.match(session, /hasActiveMfa/);
  assert.doesNotMatch(verify, /appAudience === "client"[\s\S]{0,120}status: 404/);
  assert.doesNotMatch(appLogin, /当前客户端会话返回了无效的双重验证要求/);
  for (const source of [login, verify, confirm]) assert.match(source, /readResearchJson\(request, (?:2_048|4_096)\)/);
});

test("Client account page exposes enrollment, status and verified recovery rotation without retaining secrets", async () => {
  const start = await read("app/api/auth/mfa/enroll/start/route.shared.ts");
  const confirm = await read("app/api/auth/mfa/enroll/confirm/route.shared.ts");
  const recovery = await read("app/api/auth/mfa/recovery-codes/route.shared.ts");
  const workspace = await read("apps/client/ui/account-security-workspace.tsx");
  const panel = await read("apps/client/ui/client-mfa-panel.tsx");
  assert.doesNotMatch(start, /appAudience === "client"[\s\S]{0,120}status: 404/);
  assert.doesNotMatch(confirm, /appAudience === "client"[\s\S]{0,120}status: 404/);
  for (const endpoint of [
    "/api/auth/mfa/enroll/start",
    "/api/auth/mfa/enroll/confirm",
    "/api/auth/mfa/recovery-codes",
  ]) assert.ok(panel.includes(endpoint));
  assert.match(recovery, /verificationCode/);
  assert.match(workspace, /ClientMfaPanel/);
  assert.match(panel, /recoveryCodes/);
  assert.match(panel, /aria-live/);
  assert.doesNotMatch(recovery, /encrypted_secret.*Response\.json|SELECT \*/);
});
