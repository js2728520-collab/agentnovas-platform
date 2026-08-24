import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

async function source(file) {
  return readFile(join(root, "tests/e2e", file), "utf8");
}

function assertPathsCovered(contents, paths, file) {
  for (const path of paths) {
    assert.match(contents, new RegExp(`(?:["'\\x60])${path.replaceAll("/", "\\/")}(?:["'\\x60])`), `${file} must cover ${path}`);
  }
}

test("the browser suite covers every stable Client beta page", async () => {
  const contents = await source("client-ui.spec.ts");
  assertPathsCovered(contents, [
    "/",
    "/membership",
    "/membership/orders",
    "/credits",
    "/paper",
    "/trading-hall",
    "/work-records",
    "/performance-statements",
    "/wallet",
    "/wallet/deposits",
    "/market",
    "/notifications",
    "/account/security",
    "/support",
  ], "client-ui.spec.ts");
  assert.match(contents, /expectAudienceNavigation\(page,\s*"client"\)/);
  assert.equal((contents.match(/\btest\(/g) ?? []).length, 4, "Client coverage must remain folded into four release-gate cases");
});

test("Operations and Maintenance cases cover representative stable pages and audience-menu isolation", async () => {
  const maker = await source("operations-maker-ui.spec.ts");
  const checker = await source("operations-checker-ui.spec.ts");
  const maintenance = await source("maintenance-admin-ui.spec.ts");

  assertPathsCovered(maker, ["/customers", "/accounts", "/membership-orders", "/performance-statements", "/credits", "/deposits", "/ledger", "/finance"], "operations-maker-ui.spec.ts");
  assertPathsCovered(await source("g1-identity-security.spec.ts"), ["/invitations"], "g1-identity-security.spec.ts");
  assertPathsCovered(checker, ["/", "/approvals"], "operations-checker-ui.spec.ts");
  assert.match(`${maker}\n${checker}`, /expectAudienceNavigation\(page,\s*"operations"\)/);
  assert.equal((maker.match(/\btest\(/g) ?? []).length, 3, "maker coverage includes the no-PII negative case");
  assert.equal((checker.match(/\btest\(/g) ?? []).length, 2, "checker coverage includes the audited PII reveal case");

  assertPathsCovered(maintenance, ["/", "/health", "/models", "/integrations", "/integrations/sources", "/integrations/email", "/integrations/payments", "/integrations/demo-exchanges", "/settings", "/configurations", "/audit", "/releases", "/ai-usage"], "maintenance-admin-ui.spec.ts");
  assert.match(maintenance, /expectAudienceNavigation\(page,\s*"maintenance"\)/);
  assert.match(maintenance, /运行确定性测试/);
  assert.match(maintenance, /postDataJSON\(\)/);
  assert.equal((maintenance.match(/\btest\(/g) ?? []).length, 4, "Maintenance coverage includes dialog-free configuration and AI usage recovery flows");
});

test("every stable-page navigation uses the shared browser quality exercise", async () => {
  for (const file of [
    "client-ui.spec.ts",
    "operations-maker-ui.spec.ts",
    "operations-checker-ui.spec.ts",
    "maintenance-admin-ui.spec.ts",
  ]) {
    assert.match(await source(file), /exerciseResponsiveWidths/);
  }
});

test("three-audience login completion relies on authenticated UI state instead of network idleness", async () => {
  const identity = await source("g1-identity-security.spec.ts");
  assert.match(identity, /toHaveURL\(`/);
  assert.match(identity, /getByRole\("heading"/);
  assert.doesNotMatch(identity, /waitForLoadState\("networkidle"\)|waitUntil:\s*"networkidle"/);
});

test("isolated browser teardown ignores only already-handled routes after closing starts", async () => {
  const support = await source("support/quality-test.ts");
  assert.match(support, /closing && error instanceof Error && error\.message\.includes\("Route is already handled"\)/);
  assert.match(support, /openedPage\.on\("requestfailed", \(request\) => \{\s*if \(closing\) return;/);
  assert.match(support, /context\.unrouteAll\(\{ behavior: "ignoreErrors" \}\)/);
  assert.match(support, /throw new Error\(`isolated loopback fulfill failed/);
});
