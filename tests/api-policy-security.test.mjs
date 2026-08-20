import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { relative, sep } from "node:path";
import test from "node:test";

import { API_ROUTE_INVENTORY } from "../lib/api-route-inventory.ts";
import {
  ApiPolicyError,
  apiPolicyForRoute,
  apiErrorResponse,
  evaluateApiRequestPolicy,
  normalizeRequestId,
} from "../lib/api-policy.ts";
import { resolveAppAudienceStrict } from "../lib/riverton-apps.ts";

const appApi = new URL("../app/api/", import.meta.url);

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const rows = await Promise.all(entries.map((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? routeFiles(path) : [path];
  }));
  return rows.flat();
}

function routePattern(pathname) {
  const root = appApi.pathname;
  const local = relative(root, pathname).split(sep).join("/").replace(/\/route\.ts$/, "");
  return `/api/${local}`
    .replace(/\[\.\.\.([^\]]+)\]/g, ":$1*")
    .replace(/\[([^\]]+)\]/g, ":$1");
}

test("the versioned inventory covers every exported API method and route", async () => {
  const discovered = [];
  for (const file of await routeFiles(appApi)) {
    if (!file.pathname.endsWith("/route.ts")) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
      discovered.push(`${match[1]} ${routePattern(file.pathname)}`);
    }
  }
  assert.equal(discovered.length, 175);
  assert.deepEqual(
    API_ROUTE_INVENTORY.map((entry) => `${entry.method} ${entry.route}`).sort(),
    discovered.sort(),
  );
  for (const entry of API_ROUTE_INVENTORY) {
    assert.doesNotThrow(() => apiPolicyForRoute(entry.route, entry.method), `${entry.method} ${entry.route}`);
  }
});

test("unknown hosts and cross-audience sensitive routes fail closed", () => {
  assert.equal(resolveAppAudienceStrict({ host: "untrusted.example" }), null);

  assert.throws(() => evaluateApiRequestPolicy(new Request("https://untrusted.example/api/auth/me")),
    (error) => error instanceof ApiPolicyError && error.code === "UNKNOWN_AUDIENCE" && error.status === 404);
  assert.throws(() => evaluateApiRequestPolicy(new Request("https://xm.agentnovas.com/api/operations/deposits")),
    (error) => error instanceof ApiPolicyError && error.code === "ROUTE_NOT_AVAILABLE" && error.status === 404);
  assert.throws(() => evaluateApiRequestPolicy(new Request("https://zht.agentnovas.com/api/maintenance/payment-providers")),
    (error) => error instanceof ApiPolicyError && error.code === "ROUTE_NOT_AVAILABLE" && error.status === 404);
  assert.throws(() => evaluateApiRequestPolicy(new Request("https://agentnovas.com/api/access/roles")),
    (error) => error instanceof ApiPolicyError && error.code === "ROUTE_NOT_AVAILABLE" && error.status === 404);

  assert.equal(evaluateApiRequestPolicy(new Request("https://zht.agentnovas.com/api/access/roles")).audience, "operations");
  assert.equal(evaluateApiRequestPolicy(new Request("https://xm.agentnovas.com/api/access/roles")).audience, "maintenance");
  assert.equal(evaluateApiRequestPolicy(new Request("https://zht.agentnovas.com/api/auth/mfa/verify", {
    method: "POST",
    headers: { origin: "https://zht.agentnovas.com" },
  })).audience, "operations");
  assert.throws(() => evaluateApiRequestPolicy(new Request("https://agentnovas.com/api/auth/mfa/verify", { method: "POST" })),
    (error) => error instanceof ApiPolicyError && error.code === "ROUTE_NOT_AVAILABLE" && error.status === 404);
});

test("legacy sensitive surfaces are assigned to their owning application", () => {
  for (const pathname of [
    "/api/approvals",
    "/api/data-center",
    "/api/finance/settlements",
    "/api/organization/members",
    "/api/team/monthly-targets",
  ]) {
    assert.equal(evaluateApiRequestPolicy(new Request(`https://zht.agentnovas.com${pathname}`)).audience, "operations");
    assert.throws(() => evaluateApiRequestPolicy(new Request(`https://xm.agentnovas.com${pathname}`)),
      (error) => error instanceof ApiPolicyError && error.status === 404);
  }
  assert.equal(evaluateApiRequestPolicy(new Request("https://xm.agentnovas.com/api/admin/llm-profiles")).audience, "maintenance");
  assert.deepEqual(apiPolicyForRoute("/api/membership/orders", "POST").audiences, ["client"]);
  assert.deepEqual(apiPolicyForRoute("/api/credits/me", "GET").audiences, ["client"]);
  assert.deepEqual(apiPolicyForRoute("/api/operations/performance-statements/:id", "GET").audiences, ["operations"]);
  assert.deepEqual(apiPolicyForRoute("/api/maintenance/demo-exchanges/:id/kill", "POST").audiences, ["maintenance"]);
});

test("request ids are bounded and internal errors are not exposed", async () => {
  assert.equal(normalizeRequestId("trace_0123456789abcdef"), "trace_0123456789abcdef");
  assert.equal(normalizeRequestId("bad\nheader"), null);
  assert.equal(normalizeRequestId("x".repeat(129)), null);

  const response = apiErrorResponse(new Error("database password leaked"), "request_12345678");
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("x-request-id"), "request_12345678");
  assert.deepEqual(await response.json(), {
    error: { code: "INTERNAL_ERROR", message: "服务器处理失败" },
    requestId: "request_12345678",
  });
});

test("browser mutations require an exact same-origin header", () => {
  const sameOrigin = new Request("https://zht.agentnovas.com/api/auth/login", {
    method: "POST",
    headers: { origin: "https://zht.agentnovas.com" },
  });
  assert.equal(evaluateApiRequestPolicy(sameOrigin).audience, "operations");
  for (const request of [
    new Request("https://zht.agentnovas.com/api/auth/login", { method: "POST" }),
    new Request("https://zht.agentnovas.com/api/auth/login", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }),
    new Request("https://zht.agentnovas.com/api/auth/login", {
      method: "POST",
      headers: { origin: "http://zht.agentnovas.com" },
    }),
  ]) {
    assert.throws(() => evaluateApiRequestPolicy(request),
      (error) => error instanceof ApiPolicyError && error.code.startsWith("CSRF_") && error.status === 403);
  }
});

test("Next 16 Proxy applies the central policy before API Route Handlers", async () => {
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /evaluateApiRequestPolicy/);
  assert.match(proxy, /matcher:\s*"\/api\/:path\*"/);
  assert.match(proxy, /x-request-id/);
  assert.doesNotMatch(proxy, /getPostgresPool|getDb|DATABASE_URL/);
});
