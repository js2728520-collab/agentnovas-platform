import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("internal invitations and activation never return or queue plaintext temporary passwords", async () => {
  const files = await Promise.all([
    "../app/api/organization/members/route.ts",
    "../app/api/organization/members/[id]/activate/route.ts",
    "../lib/internal-member-provisioning.ts",
    "../lib/notification-email-worker.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of files) {
    assert.doesNotMatch(source, /temporaryPassword|临时密码/);
  }
  assert.match(files.join("\n"), /reset_password/);
  assert.match(files[0], /encryptNotificationToken\(activationToken\)/);
  assert.match(files[0], /encryptedToken/);
  assert.doesNotMatch(files[0], /payloadJson:\s*JSON\.stringify\(\{ token:/);
  assert.doesNotMatch(files[1], /passwordHash/);
  assert.match(files[1], /secretKind:\s*"internal_account_invite"/);
  assert.match(files[2], /secret_kind, secret_expires_at/);
});
