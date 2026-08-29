import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("account sessions expose only masked device evidence and revoke owned non-current sessions", async () => {
  const route = await read("app/api/account/sessions/route.shared.ts");
  assert.match(route, /requireCurrentSession/);
  assert.match(route, /maskIpAddress/);
  assert.match(route, /summarizeUserAgent/);
  assert.match(route, /revoked_at/);
  assert.match(route, /session\.user_id=\$1/);
  assert.match(route, /CURRENT_SESSION_LOGOUT_REQUIRED/);
  assert.match(route, /account\.session_revoked/);
  assert.doesNotMatch(route, /token_hash.*Response\.json|SELECT \*/);
});

test("Client account security is a stable route with profile, password and sessions", async () => {
  const contract = await read("app/riverton-route-contract.ts");
  const portal = await read("apps/client/ui/client-portal.tsx");
  const shell = await read("apps/client/ui/client-portal-shell.tsx");
  const workspace = await read("apps/client/ui/account-security-workspace.tsx");
  assert.match(contract, /"account"/);
  assert.match(portal, /AccountSecurityWorkspace/);
  assert.match(shell, /href="\/settings"/);
  assert.match(portal, /\["settings", "account"\]/);
  assert.doesNotMatch(portal, /\["settings", "account", "legal"\]/);
  assert.match(portal, /section="security"/);
  for (const endpoint of ["/api/account/profile", "/api/account/password", "/api/account/sessions"]) assert.ok(workspace.includes(endpoint));
  assert.match(workspace, /aria-live/);
  assert.match(workspace, /确认/);
});

test("account profile and password mutations bound request bodies and return domain errors", async () => {
  const profile = await read("app/api/account/profile/route.client.ts");
  const password = await read("app/api/account/password/route.client.ts");
  for (const source of [profile, password]) {
    assert.match(source, /readResearchJson\(request, 4_096\)/);
    assert.match(source, /ResearchApiError/);
    assert.match(source, /responseError\(error, request\.headers\.get\("x-request-id"\)/);
  }
  assert.match(profile, /PROFILE_USERNAME_INVALID/);
  assert.match(profile, /PROFILE_DATE_INVALID/);
  assert.match(profile, /currentPassword/);
  assert.match(profile, /updateAccountProfile/);
  assert.match(password, /PASSWORD_LENGTH_INVALID/);
  assert.match(password, /CURRENT_PASSWORD_INVALID/);
});

test("Client support page shows only configured public channels and no fake ticket workflow", async () => {
  const contract = await read("app/riverton-route-contract.ts");
  const portal = await read("apps/client/ui/client-portal.tsx");
  const shell = await read("apps/client/ui/client-portal-shell.tsx");
  const support = await read("apps/client/ui/support-workspace.tsx");
  assert.match(contract, /"support"/);
  assert.match(portal, /SupportWorkspace/);
  assert.match(shell, /\/support/);
  assert.match(support, /\/api\/platform\/settings/);
  assert.match(support, /system\?\.telegramSupportUrl &&/);
  assert.match(support, /system\?\.supportEmail &&/);
  assert.match(support, /hasChannel \?/);
  assert.doesNotMatch(support, /Telegram 尚未配置|客服邮箱尚未配置/);
  assert.doesNotMatch(support, /提交工单|工单已创建|ticket.*created/i);
});
