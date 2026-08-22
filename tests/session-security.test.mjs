import assert from "node:assert/strict";
import test from "node:test";

import {
  authConnectionBucketKey,
  clientIpFromRequest,
  sessionCookieHeaders,
  sessionPolicyForAudience,
} from "../lib/riverton-apps.ts";

test("client and internal sessions use different idle and absolute lifetimes", () => {
  assert.deepEqual(sessionPolicyForAudience("client"), {
    absoluteSeconds: 7 * 24 * 60 * 60,
    idleSeconds: 24 * 60 * 60,
  });
  assert.deepEqual(sessionPolicyForAudience("operations"), {
    absoluteSeconds: 12 * 60 * 60,
    idleSeconds: 60 * 60,
  });
  assert.deepEqual(sessionPolicyForAudience("maintenance"), {
    absoluteSeconds: 12 * 60 * 60,
    idleSeconds: 60 * 60,
  });
});

test("production cookies are Secure even when TLS terminates at an explicitly trusted proxy", () => {
  const result = sessionCookieHeaders({
    request: new Request("http://127.0.0.1:3000/api/auth/login", { headers: { host: "agentnovas.com" } }),
    token: "token",
    maxAgeSeconds: 60,
    environment: { NODE_ENV: "production" },
  });
  assert.equal(result.audience, "client");
  assert.ok(result.headers.every((header) => /; Secure(?:;|$)/.test(header)));
  assert.ok(result.headers.every((header) => /HttpOnly/.test(header) && /SameSite=Strict/.test(header)));
  assert.ok(result.headers.every((header) => !/Domain=/.test(header)));
});

test("forwarded client addresses are ignored until a proxy hop count is explicitly configured", () => {
  const request = new Request("https://zht.agentnovas.com/api/auth/login", {
    headers: { "x-forwarded-for": "198.51.100.2, 10.0.0.5", "x-real-ip": "198.51.100.9" },
  });
  assert.equal(clientIpFromRequest(request, {}), null);
  assert.equal(clientIpFromRequest(request, { TRUST_PROXY_HOPS: "1" }), "10.0.0.5");
  assert.equal(clientIpFromRequest(request, { TRUST_PROXY_HOPS: "2" }), "198.51.100.2");
  assert.equal(clientIpFromRequest(request, { TRUST_PROXY_HOPS: "invalid" }), null);
  assert.equal(authConnectionBucketKey(request, { NODE_ENV: "production" }), null);
  assert.deepEqual(authConnectionBucketKey(request, { NODE_ENV: "development" }), {
    bucketKey: "connection:unattributed-nonproduction",
    ipAddress: null,
  });
});

test("deploy example leaves proxy trust disabled until the operator confirms the network boundary", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../deploy/agentnovas.env.example", import.meta.url), "utf8"));
  assert.match(source, /TRUST_PROXY_HOPS=\s*(?:\n|$)/);
  assert.match(source, /directly reachable|仅由受控反向代理直连/i);
});
