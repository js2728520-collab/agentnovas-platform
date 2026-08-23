import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("account security exposes an audited logout-all action that clears the current cookie", async () => {
  const route = await readFile(new URL("../app/api/account/sessions/route.shared.ts", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../apps/client/ui/account-security-workspace.tsx", import.meta.url), "utf8");
  assert.match(route, /export async function POST/);
  assert.match(route, /client_revoke_all_sessions/);
  assert.match(route, /account\.sessions_revoked_all/);
  assert.match(route, /clearSessionCookieHeaders/);
  assert.match(workspace, /退出全部设备/);
  assert.match(workspace, /method: "POST"/);
  assert.match(workspace, /\/api\/account\/sessions/);
});
