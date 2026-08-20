import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("notification worker keeps retention cleanup active when external sending is disabled", async () => {
  const source = await readFile(new URL("../scripts/notification-worker.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /if \(!notificationSendEnvironmentReady\(process\.env\)\) \{\s*throw/);
  assert.match(source, /const sendEnabled = notificationSendEnvironmentReady\(process\.env\)/);
  assert.match(source, /try \{\s*await purgeExpiredNotificationSecrets\(pool, now\)/s);
  assert.match(source, /catch \(error\) \{\s*console\.error\("Notification secret cleanup failed"/s);
  assert.match(source, /if \(!sendEnabled\) \{\s*await delay/s);
});
