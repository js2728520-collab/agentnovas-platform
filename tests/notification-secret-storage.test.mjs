import assert from "node:assert/strict";
import test from "node:test";

import { decryptNotificationToken, encryptNotificationToken } from "../lib/notification-secrets.ts";

const environment = { NOTIFICATION_TOKEN_ENCRYPTION_KEY: "test-notification-token-key-longer-than-thirty-two-characters" };

test("notification bearer tokens are authenticated-encrypted and never embedded in stored payload JSON", async () => {
  const raw = "one-time-bearer-token";
  const encryptedToken = await encryptNotificationToken(raw, environment);
  assert.match(encryptedToken, /^v1\./);
  assert.doesNotMatch(encryptedToken, new RegExp(raw));
  assert.equal(await decryptNotificationToken(encryptedToken, environment), raw);
  const stored = JSON.stringify({ encryptedToken, audience: "operations" });
  assert.doesNotMatch(stored, new RegExp(raw));
  await assert.rejects(() => decryptNotificationToken(`${encryptedToken}tampered`, environment));
});
