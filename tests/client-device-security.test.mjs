import assert from "node:assert/strict";
import test from "node:test";

import {
  clientDeviceIdentity,
  clientNetworkKey,
  describeClientDevice,
  maskNetworkAddress,
} from "../lib/client-device-security.ts";

test("client device identity reuses a valid HttpOnly cookie and hashes it before persistence", async () => {
  const raw = "A".repeat(43);
  const request = new Request("https://agentnovas.com/api/auth/login", {
    headers: { cookie: `rc_client_device=${raw}` },
  });
  const identity = await clientDeviceIdentity(request, { NODE_ENV: "production" });
  assert.equal(identity.isNewCookie, false);
  assert.equal(identity.cookieHeader, null);
  assert.match(identity.deviceHash, /^[a-f0-9]{64}$/);
  assert.notEqual(identity.deviceHash, raw);
});

test("missing client device identity issues a long-lived strict cookie", async () => {
  const identity = await clientDeviceIdentity(
    new Request("https://agentnovas.com/api/auth/login"),
    { NODE_ENV: "production" },
  );
  assert.equal(identity.isNewCookie, true);
  assert.match(identity.cookieHeader ?? "", /^rc_client_device=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000; Secure$/);
});

test("network comparison uses bounded prefixes and UI exposure is masked", () => {
  assert.equal(clientNetworkKey("203.0.113.88"), "ipv4:203.0.113");
  assert.equal(maskNetworkAddress("203.0.113.88"), "203.0.113.x");
  assert.equal(clientNetworkKey("2001:db8:abcd:12::42"), "ipv6:2001:db8:abcd");
  assert.equal(maskNetworkAddress("2001:db8:abcd:12::42"), "2001:db8:abcd::");
  assert.equal(clientNetworkKey(null), "unattributed");
  assert.equal(maskNetworkAddress(null), null);
});

test("device descriptions are bounded and do not expose the raw user agent", () => {
  assert.equal(describeClientDevice("Mozilla/5.0 (Macintosh) AppleWebKit Safari/17.5"), "Safari · macOS");
  assert.equal(describeClientDevice("Mozilla/5.0 (Linux; Android 14) Chrome/130.0"), "Chrome · Android");
  assert.equal(describeClientDevice("x".repeat(2_000)), "浏览器 · 未知系统");
  assert.equal(describeClientDevice(null), "未知设备");
});
