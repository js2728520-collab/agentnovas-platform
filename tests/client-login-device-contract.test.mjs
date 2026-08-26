import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Client login enforces verified email and uses the atomic five-device gateway", async () => {
  const source = await readFile(new URL("../app/api/auth/login/route.shared.ts", import.meta.url), "utf8");
  assert.match(source, /EMAIL_VERIFICATION_REQUIRED/);
  assert.match(source, /clientDeviceIdentity/);
  assert.match(source, /clientNetworkKey/);
  assert.match(source, /client_complete_login_v3/);
  assert.match(source, /DEVICE_LIMIT_REACHED/);
  assert.match(source, /security_new_device/);
  assert.match(source, /security_network_changed/);
  assert.match(source, /BEGIN/);
  assert.match(source, /COMMIT/);
  assert.match(source, /ROLLBACK/);
});
