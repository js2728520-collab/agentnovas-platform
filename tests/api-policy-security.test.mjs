import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { relative, sep } from "node:path";
import test from "node:test";
import ts from "typescript";
import { promisify } from "node:util";

import { API_ROUTE_INVENTORY } from "../lib/api-route-inventory.ts";
import {
  ApiPolicyError,
  apiPolicyForRoute,
  apiErrorResponse,
  evaluateApiRequestPolicy,
  normalizeRequestId,
} from "../lib/api-policy.ts";
import { researchErrorResponse } from "../lib/research-error-response.ts";
import { ResearchApiError } from "../lib/research-errors.ts";
import { contentSecurityPolicy } from "../lib/content-security-policy.ts";
import { resolveAppAudienceStrict } from "../lib/riverton-apps.ts";
import { SENSITIVE_PERMISSION_KEYS } from "../lib/rbac.ts";

const appApi = new URL("../app/api/", import.meta.url);
const execFileAsync = promisify(execFile);

test("commercial mutations preserve the proxy request id", async () => {
  const source = await readFile(new URL("../lib/commercial-api.ts", import.meta.url), "utf8");
  const request = new Request("https://agentnovas.com/api/membership/orders", {
    headers: { "x-request-id": "req-commercial-123" },
  });
  assert.equal(normalizeRequestId(request.headers.get("x-request-id")), "req-commercial-123");
  assert.match(source, /import \{ requestIdFor \} from "\.\/api-policy\.ts"/);
  assert.match(source, /return requestIdFor\(request\)/);
});

async function routeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const rows = await Promise.all(entries.map((entry) => {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    return entry.isDirectory() ? routeFiles(path) : [path];
  }));
  return rows.flat();
}

// 路由文件按 audience 归属命名（见 next.config.ts 的 pageExtensions）。
const ROUTE_FILE = /\/route\.(client|operations|maintenance|internal|shared)\.ts$/;

function routePattern(pathname) {
  const root = appApi.pathname;
  const local = relative(root, pathname).split(sep).join("/").replace(ROUTE_FILE, "");
  return `/api/${local}`
    .replace(/\[\.\.\.([^\]]+)\]/g, ":$1*")
    .replace(/\[([^\]]+)\]/g, ":$1");
}

test("the versioned inventory covers every exported API method and route", async () => {
  const discovered = [];
  for (const file of await routeFiles(appApi)) {
    if (!ROUTE_FILE.test(file.pathname)) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
      discovered.push(`${match[1]} ${routePattern(file.pathname)}`);
    }
  }
  assert.ok(discovered.length > 0);
  assert.deepEqual(
    API_ROUTE_INVENTORY.map((entry) => `${entry.method} ${entry.route}`).sort(),
    discovered.sort(),
  );
  for (const entry of API_ROUTE_INVENTORY) {
    assert.doesNotThrow(() => apiPolicyForRoute(entry.route, entry.method), `${entry.method} ${entry.route}`);
  }
});

test("the generated route security inventory is current", async () => {
  await execFileAsync(process.execPath, ["scripts/generate-api-route-inventory.mjs", "--check"], {
    cwd: new URL("..", import.meta.url),
  });
});

test("permission inventory declares exact grants and matches each handler's DB authorization helper", async () => {
  const wrapperPermissions = {
    requireCurrentAccessAdmin: ["ops.roles.manage", "maint.roles.manage"],
    requireCurrentAccessViewer: ["ops.roles.manage", "ops.roles.assign", "ops.roles.approve_sensitive", "maint.roles.manage", "maint.roles.approve_sensitive"],
    requireCurrentAccessAssignmentAdmin: ["ops.roles.assign", "ops.roles.manage", "maint.roles.manage"],
    requireCurrentAccessReviewer: ["ops.roles.approve_sensitive", "ops.roles.manage", "maint.roles.approve_sensitive", "maint.roles.manage"],
    requireCurrentAccessAudit: ["ops.roles.manage", "ops.roles.approve_sensitive", "maint.audit.view", "maint.roles.manage"],
  };
  const permissionEntries = API_ROUTE_INVENTORY.filter((entry) => entry.authentication === "permission");
  assert.ok(permissionEntries.length > 0);
  for (const entry of permissionEntries) {
    assert.ok(entry.permissionKeys.length > 0, `${entry.method} ${entry.route} has no exact permission`);
    assert.ok(["grant", "platform"].includes(entry.scope), `${entry.method} ${entry.route} has no scope contract`);
    assert.ok(["none", "recent", "conditional"].includes(entry.mfa), `${entry.method} ${entry.route} has no MFA contract`);
    assert.ok(["none", "masked", "full"].includes(entry.pii), `${entry.method} ${entry.route} has no PII contract`);
    assert.ok(["normal", "sensitive"].includes(entry.sensitivity), `${entry.method} ${entry.route} has no sensitivity contract`);

    const source = await readFile(new URL(`../${entry.source}`, import.meta.url), "utf8");
    assert.match(source, /require(?:Any)?AccessPermission|requireCurrentAccess/, `${entry.method} ${entry.route} has metadata without DB auth`);
    const declaredBySource = new Set(entry.permissionKeys.filter((key) => source.includes(`"${key}"`)));
    for (const [helper, keys] of Object.entries(wrapperPermissions)) {
      if (source.includes(`${helper}(`)) keys.filter((key) => entry.permissionKeys.includes(key)).forEach((key) => declaredBySource.add(key));
    }
    assert.deepEqual([...declaredBySource].sort(), [...entry.permissionKeys].sort(), `${entry.method} ${entry.route} metadata does not match helper`);
    assert.deepEqual(Object.keys(entry.permissionMfa ?? {}).sort(), [...entry.permissionKeys].sort(), `${entry.method} ${entry.route} lacks per-permission MFA metadata`);
    for (const permissionKey of entry.permissionKeys) {
      const expected = SENSITIVE_PERMISSION_KEYS.has(permissionKey) && !permissionKey.startsWith("client.") ? "recent" : "none";
      assert.equal(entry.permissionMfa[permissionKey], expected, `${entry.method} ${entry.route} ${permissionKey}`);
    }
    assert.doesNotMatch(source, /\brequireUser\s*\(|\bcurrentUser\s*\(/, `${entry.method} ${entry.route} still relies on a legacy session/role helper`);
  }
});

test("mixed permission alternatives declare conditional rather than unconditional recent MFA", () => {
  for (const [method, route] of [
    ["GET", "/api/admin/llm-profiles"],
    ["GET", "/api/admin/agent-role-bindings"],
    ["GET", "/api/maintenance/email/status"],
    ["GET", "/api/maintenance/payment-providers"],
  ]) {
    assert.equal(apiPolicyForRoute(route, method).mfa, "conditional", `${method} ${route}`);
  }
  assert.equal(apiPolicyForRoute("/api/admin/llm-profiles", "POST").mfa, "recent");
});

test("session metadata names a method-level enforcing helper and public routes stay anonymous", () => {
  for (const entry of API_ROUTE_INVENTORY.filter((candidate) => candidate.authentication === "session")) {
    assert.ok(entry.sessionAuthHelpers?.length > 0, `${entry.method} ${entry.route} has descriptive-only session metadata`);
  }
  for (const [method, route] of [
    ["GET", "/api/auth/me"],
    ["POST", "/api/auth/logout"],
    ["POST", "/api/automation/demo-cycle"],
    ["POST", "/api/automation/platform-ai-cycle"],
    ["GET", "/api/market/candles"],
    ["GET", "/api/market/instruments"],
    ["GET", "/api/market/news"],
    ["GET", "/api/market/quote"],
    ["GET", "/api/market/ticker"],
    ["GET", "/api/platform/settings"],
    ["POST", "/api/strategy-studio/chat"],
  ]) {
    assert.equal(apiPolicyForRoute(route, method).authentication, "anonymous", `${method} ${route}`);
  }
  assert.equal(apiPolicyForRoute("/api/strategy-marketplace", "GET").authentication, "disabled");
  assert.equal(apiPolicyForRoute("/api/strategy-marketplace", "POST").authentication, "disabled");
});

test("commercial and official paper client routes declare exact RBAC permissions", () => {
  const expected = new Map([
    ["GET /api/credits/me", "client.credits.view"],
    ["GET /api/membership/me", "client.membership.view"],
    ["GET /api/wallet/balances", "client.wallet.view"],
    ["GET /api/wallet/ledger", "client.wallet.view"],
    ["POST /api/membership/orders", "client.membership.order"],
    ["GET /api/trading-hall", "client.paper.view"],
    ["GET /api/trading-hall/paper/portfolio", "client.paper.view"],
    ["GET /api/trading-hall/paper/trades", "client.paper.view"],
    ["POST /api/platform-strategies/:code/follow", "client.paper.manage"],
    ["PATCH /api/platform-strategy-subscriptions/:id", "client.paper.manage"],
  ]);
  for (const [key, permission] of expected) {
    const [method, route] = key.split(" ");
    const entry = API_ROUTE_INVENTORY.find((candidate) => candidate.method === method && candidate.route === route);
    assert.equal(entry?.authentication, "permission", key);
    assert.deepEqual(entry?.permissionKeys, [permission], key);
  }
});

test("Client account profile is classified as full PII and a sensitive same-origin write", () => {
  const readPolicy = apiPolicyForRoute("/api/account/profile", "GET");
  const writePolicy = apiPolicyForRoute("/api/account/profile", "PATCH");
  assert.equal(readPolicy.pii, "full");
  assert.equal(readPolicy.sensitivity, "sensitive");
  assert.equal(writePolicy.pii, "full");
  assert.equal(writePolicy.sensitivity, "sensitive");
  assert.equal(writePolicy.requiresSameOrigin, true);
});

test("client workbench access is independent from disclosure acceptance", async () => {
  const source = await readFile(new URL("../lib/access-control.ts", import.meta.url), "utf8");
  const research = await readFile(new URL("../lib/research-api.ts", import.meta.url), "utf8");
  const session = await readFile(new URL("../lib/session.ts", import.meta.url), "utf8");
  for (const implementation of [source, research, session]) {
    assert.doesNotMatch(implementation, /requireCommercialLegalConsentGate|clientRouteRequiresLegalConsent/);
  }
});

test("commercial disclosure acceptance is scoped inside membership order creation", async () => {
  const membership = await readFile(new URL("../lib/commercial-membership-service.ts", import.meta.url), "utf8");
  assert.match(membership, /createMembershipOrder[\s\S]*currentLegalDocuments/);
  assert.match(membership, /LEGAL_ACCEPTANCE_REQUIRED/);
  assert.match(membership, /commercial_legal_acceptances/);
});

test("standalone legal consent is a client session gate with same-origin protection on writes", () => {
  const read = apiPolicyForRoute("/api/membership/legal-consent", "GET");
  const write = apiPolicyForRoute("/api/membership/legal-consent", "POST");
  assert.equal(read.authentication, "session");
  assert.deepEqual(read.audiences, ["client"]);
  assert.equal(read.requiresSameOrigin, false);
  assert.equal(write.authentication, "session");
  assert.deepEqual(write.audiences, ["client"]);
  assert.equal(write.requiresSameOrigin, true);
  assert.equal(write.idempotency, true);
  assert.equal(write.sensitivity, "sensitive");
});

test("central policy declares and validates persistent idempotency contracts", () => {
  for (const route of [
    "/api/maintenance/integrations/:id/test",
    "/api/maintenance/trading/emergency-stop",
  ]) {
    const policy = apiPolicyForRoute(route, "POST");
    assert.equal(policy.idempotency, true, route);
    const url = `https://xm.agentnovas.com${route.replace(":id", "market-news")}`;
    assert.throws(() => evaluateApiRequestPolicy(new Request(url, {
      method: "POST",
      headers: { origin: "https://xm.agentnovas.com" },
    })), (error) => error instanceof ApiPolicyError
      && error.code === "IDEMPOTENCY_KEY_REQUIRED"
      && error.status === 422);
    assert.throws(() => evaluateApiRequestPolicy(new Request(url, {
      method: "POST",
      headers: {
        origin: "https://xm.agentnovas.com",
        "idempotency-key": "short",
      },
    })), (error) => error instanceof ApiPolicyError
      && error.code === "IDEMPOTENCY_KEY_REQUIRED"
      && error.status === 422);
    assert.equal(evaluateApiRequestPolicy(new Request(url, {
      method: "POST",
      headers: {
        origin: "https://xm.agentnovas.com",
        "idempotency-key": "maintenance-command-123",
      },
    })).audience, "maintenance");
  }
  assert.equal(apiPolicyForRoute("/api/maintenance/integrations/catalog", "GET").idempotency, false);
});

test("payment webhook is provider-authenticated without browser CSRF semantics", () => {
  assert.equal(apiPolicyForRoute("/api/integrations/payments/:provider/webhook", "POST").authentication, "webhook");
  assert.equal(evaluateApiRequestPolicy(new Request(
    "https://xm.agentnovas.com/api/integrations/payments/mock/webhook",
    {
      method: "POST",
      headers: {
        host: "xm.agentnovas.com",
      },
    },
  )).audience, "maintenance");
  assert.equal(apiPolicyForRoute("/api/integrations/resend/webhook", "POST").authentication, "webhook");
});

test("commercial beta rejects legacy customer credentials, funding, and trading surfaces at the proxy", () => {
  const disabled = [
    ["GET", "/api/notifications/channels"],
    ["GET", "/api/integrations/catalog"],
    ["GET", "/api/public-pool"],
    ["POST", "/api/exchange-accounts"],
    ["PATCH", "/api/exchange-accounts/:id"],
    ["GET", "/api/risk/status"],
    ["POST", "/api/strategies/:strategyId/versions/:versionId/deployments"],
    ["POST", "/api/strategy-research/runs"],
    ["GET", "/api/strategy-deployments/:id"],
    ["GET", "/api/strategy-deployments/:id/cycles"],
    ["POST", "/api/strategy-deployments/:id/pause"],
    ["POST", "/api/strategy-deployments/:id/resume"],
    ["PATCH", "/api/strategy-subscriptions/:id"],
    ["GET", "/api/strategy-marketplace"],
    ["POST", "/api/simulated-orders"],
    ["GET", "/api/portfolio"],
    ["POST", "/api/trading/emergency-stop"],
  ];
  for (const [method, route] of disabled) {
    assert.equal(apiPolicyForRoute(route, method).authentication, "disabled", `${method} ${route}`);
  }
  assert.equal(apiPolicyForRoute("/api/wallet/deposit-orders", "GET").authentication, "permission");
  assert.equal(apiPolicyForRoute("/api/wallet/deposit-orders", "POST").authentication, "permission");
  assert.equal(apiPolicyForRoute("/api/wallet/deposit-orders", "POST").idempotency, true);
  assert.throws(() => evaluateApiRequestPolicy(new Request(
    "https://agentnovas.com/api/exchange-accounts",
    { method: "POST", headers: { origin: "https://agentnovas.com" } },
  )), (error) => error instanceof ApiPolicyError && error.code === "ROUTE_DISABLED" && error.status === 503);
  assert.equal(apiPolicyForRoute("/api/platform-strategies/:code/follow", "POST").authentication, "permission");
});

test("unknown hosts and cross-audience sensitive routes fail closed", () => {
  assert.equal(resolveAppAudienceStrict({ host: "untrusted.example" }), null);
  assert.equal(resolveAppAudienceStrict({
    host: "untrusted.example",
    environment: { RIVERTON_APP_AUDIENCE: "maintenance" },
  }), null);
  assert.equal(resolveAppAudienceStrict({
    host: "zht.agentnovas.com",
    environment: { RIVERTON_APP_AUDIENCE: "maintenance" },
  }), null);
  assert.equal(resolveAppAudienceStrict({
    host: "xm.agentnovas.com",
    environment: { RIVERTON_APP_AUDIENCE: "maintenance" },
  }), "maintenance");
  assert.equal(resolveAppAudienceStrict({
    host: "localhost:3012",
    environment: { RIVERTON_APP_AUDIENCE: "maintenance", RIVERTON_APP_LOCAL_PORT: "3012" },
  }), "maintenance");
  assert.equal(resolveAppAudienceStrict({
    host: "localhost:3002",
    environment: { RIVERTON_APP_AUDIENCE: "maintenance", RIVERTON_APP_LOCAL_PORT: "3012" },
  }), null);
  for (const localPort of ["0", "65536", "not-a-port"]) {
    assert.equal(resolveAppAudienceStrict({
      host: "xm.agentnovas.com",
      environment: { RIVERTON_APP_AUDIENCE: "maintenance", RIVERTON_APP_LOCAL_PORT: localPort },
    }), null);
  }

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
  assert.equal(evaluateApiRequestPolicy(new Request("https://agentnovas.com/api/auth/mfa/verify", {
    method: "POST",
    headers: { origin: "https://agentnovas.com" },
  })).audience, "client");
  assert.throws(() => evaluateApiRequestPolicy(new Request("https://agentnovas.com/api/auth/mfa/verify", { method: "POST" })),
    (error) => error instanceof ApiPolicyError && error.code === "CSRF_ORIGIN_REQUIRED" && error.status === 403);
});

test("a configured process still rejects an unknown Host and attacker-controlled Origin", () => {
  const previous = process.env.RIVERTON_APP_AUDIENCE;
  process.env.RIVERTON_APP_AUDIENCE = "maintenance";
  try {
    assert.throws(() => evaluateApiRequestPolicy(new Request("https://evil.example/api/admin/follow-policy", {
      method: "PUT",
      headers: { host: "evil.example", origin: "https://evil.example" },
    })), (error) => error instanceof ApiPolicyError && error.code === "UNKNOWN_AUDIENCE" && error.status === 404);
    assert.throws(() => evaluateApiRequestPolicy(new Request("https://zht.agentnovas.com/api/admin/follow-policy", {
      method: "PUT",
      headers: { host: "zht.agentnovas.com", origin: "https://zht.agentnovas.com" },
    })), (error) => error instanceof ApiPolicyError && error.code === "UNKNOWN_AUDIENCE" && error.status === 404);
    assert.equal(evaluateApiRequestPolicy(new Request("https://xm.agentnovas.com/api/admin/follow-policy", {
      method: "PUT",
      headers: { host: "xm.agentnovas.com", origin: "https://xm.agentnovas.com" },
    })).audience, "maintenance");
  } finally {
    if (previous === undefined) delete process.env.RIVERTON_APP_AUDIENCE;
    else process.env.RIVERTON_APP_AUDIENCE = previous;
  }
});

test("legacy sensitive surfaces are assigned to their owning application", () => {
  for (const pathname of [
    "/api/approvals",
    "/api/data-center",
    "/api/organization/members",
    "/api/team/monthly-targets",
  ]) {
    assert.equal(evaluateApiRequestPolicy(new Request(`https://zht.agentnovas.com${pathname}`)).audience, "operations");
    assert.throws(() => evaluateApiRequestPolicy(new Request(`https://xm.agentnovas.com${pathname}`)),
      (error) => error instanceof ApiPolicyError && error.status === 404);
  }
  assert.deepEqual(apiPolicyForRoute("/api/finance/settlements", "GET").audiences, ["operations"]);
  assert.equal(apiPolicyForRoute("/api/finance/settlements", "GET").authentication, "disabled");
  assert.equal(evaluateApiRequestPolicy(new Request("https://xm.agentnovas.com/api/admin/llm-profiles")).audience, "maintenance");
  assert.deepEqual(apiPolicyForRoute("/api/wallet/deposit-orders", "POST").audiences, ["client"]);
  assert.deepEqual(apiPolicyForRoute("/api/operations/deposits", "GET").audiences, ["operations"]);
  assert.deepEqual(apiPolicyForRoute("/api/maintenance/payment-providers/:id/status", "PATCH").audiences, ["maintenance"]);
  assert.deepEqual(
    apiPolicyForRoute("/api/access/me/effective", "GET").audiences,
    ["client", "operations", "maintenance"],
  );
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
  const sessionSource = await readFile(new URL("../lib/session.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sessionSource, /error instanceof Error \? error\.message/);
  assert.match(sessionSource, /requestId/);
  assert.match(sessionSource, /INTERNAL_ERROR/);
});

test("domain error envelopes carry the bounded request id in body and headers", async () => {
  const request = new Request("http://localhost:3000/api/membership/orders", {
    headers: { "x-request-id": "commercial-request-123" },
  });
  const response = researchErrorResponse(
    new ResearchApiError("VALIDATION_ERROR", "输入无效", 422, { fields: ["planCode"] }),
    request,
  );
  assert.equal(response.status, 422);
  assert.equal(response.headers.get("x-request-id"), "commercial-request-123");
  assert.deepEqual(await response.json(), {
    error: { code: "VALIDATION_ERROR", message: "输入无效", details: { fields: ["planCode"] } },
    requestId: "commercial-request-123",
  });
});

test("Response-based authentication failures retain safe 401 and 403 envelopes", async () => {
  for (const [status, code, message] of [
    [401, "AUTH_REQUIRED", "请先登录"],
    [403, "FORBIDDEN", "无权执行此操作"],
  ]) {
    const response = researchErrorResponse(new Response("do not echo this body", { status }), "auth-request-123");
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), {
      error: { code, message },
      requestId: "auth-request-123",
    });
  }
});

test("Route Handlers preserve the proxy request id in domain error responses", async () => {
  for (const file of await routeFiles(appApi)) {
    if (!ROUTE_FILE.test(file.pathname)) continue;
    const source = await readFile(file, "utf8");
    if (!source.includes("researchErrorResponse")) continue;
    const sourceFile = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "researchErrorResponse") {
        assert.ok(
          node.arguments.length >= 2,
          `${relative(appApi.pathname, file.pathname)} drops the request correlation id`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
});

test("untyped configuration errors never disclose environment or tenant details", async () => {
  const response = researchErrorResponse(
    new Error("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY 尚未配置: tenant secret detail"),
    "commercial-request-456",
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: "INTERNAL_ERROR", message: "策略研发服务处理失败", details: {} },
    requestId: "commercial-request-456",
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

test("forwarded protocol cannot satisfy Origin checks without an explicit trusted boundary", () => {
  const previous = process.env.TRUST_PROXY_HOPS;
  delete process.env.TRUST_PROXY_HOPS;
  try {
    const request = new Request("http://127.0.0.1:3001/api/auth/login", {
      method: "POST",
      headers: {
        host: "zht.agentnovas.com",
        origin: "https://zht.agentnovas.com",
        "x-forwarded-proto": "https",
      },
    });
    assert.throws(() => evaluateApiRequestPolicy(request),
      (error) => error instanceof ApiPolicyError && error.code === "CSRF_ORIGIN_MISMATCH");
    process.env.TRUST_PROXY_HOPS = "1";
    assert.equal(evaluateApiRequestPolicy(request).audience, "operations");
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = previous;
  }
});

test("strict page CSP uses a per-request nonce without allowing inline scripts", () => {
  const policy = contentSecurityPolicy("nonce_0123456789abcdef", false);
  assert.match(policy, /script-src 'self' 'nonce-nonce_0123456789abcdef' 'strict-dynamic'/);
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/);
  assert.match(policy, /style-src-attr 'unsafe-inline'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
});

test("Next 16 Proxy applies API policy and page nonce policy before rendering", async () => {
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /evaluateApiRequestPolicy/);
  assert.match(proxy, /resolveAppAudienceStrict/);
  assert.match(proxy, /contentSecurityPolicy/);
  assert.match(proxy, /x-nonce/);
  assert.match(proxy, /content-security-policy/);
  assert.match(proxy, /"\/api\/:path\*"/);
  assert.match(proxy, /_next\/static/);
  assert.match(proxy, /x-request-id/);
  assert.doesNotMatch(proxy, /getPostgresPool|getDb|DATABASE_URL/);
});

test("内联脚本必须带 CSP nonce——否则被我们自己的策略挡掉", async () => {
  // script-src 是 'self' 'nonce-…' 'strict-dynamic'，没有 unsafe-inline。
  // 漏掉 nonce 不会报错页，只会让那段脚本静默不执行：主题引导脚本被挡掉的表现是
  // 暗色用户每次加载白闪一下，而那正是它存在的唯一理由。
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const inlineScripts = layout.match(/<script[^>]*dangerouslySetInnerHTML/g) ?? [];
  assert.ok(inlineScripts.length > 0, "布局里应有主题引导脚本");
  for (const tag of inlineScripts) {
    assert.match(tag, /nonce=\{/, `内联脚本缺少 nonce：${tag}`);
  }
  // nonce 必须来自 proxy 写入的请求头，不能自己编一个——编的那个不在 CSP 里。
  assert.match(layout, /headers\(\)|requestHeaders/);
  assert.match(layout, /get\("x-nonce"\)/);

  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /requestHeaders\.set\("x-nonce", nonce\)/);
  assert.match(proxy, /contentSecurityPolicy\(nonce/);
});
