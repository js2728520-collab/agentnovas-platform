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
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(contents, new RegExp(`(?:["'\\x60])${escapedPath}(?:["'\\x60])`), `${file} must cover ${path}`);
  }
}

test("the browser suite covers every stable Client beta page", async () => {
  const contents = await source("client-ui.spec.ts");
  assertPathsCovered(contents, [
    "/",
    "/dashboard",
    "/trading",
    "/strategies",
    "/account-center",
    "/settings",
    "/assistant",
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

  assertPathsCovered(maker, ["/customers", "/accounts", "/membership-orders", "/performance-statements", "/credits", "/deposits", "/ledger", "/finance", "/commercial?tab=finance", "/commercial?tab=membership", "/governance?tab=operators", "/settings?tab=appearance"], "operations-maker-ui.spec.ts");
  assertPathsCovered(await source("g1-identity-security.spec.ts"), ["/invitations"], "g1-identity-security.spec.ts");
  assertPathsCovered(checker, ["/", "/approvals", "/governance?tab=approvals"], "operations-checker-ui.spec.ts");
  assert.match(`${maker}\n${checker}`, /expectAudienceNavigation\(page,\s*"operations"\)/);
  assert.equal((maker.match(/\btest\(/g) ?? []).length, 3, "maker coverage includes the no-PII negative case");
  assert.equal((checker.match(/\btest\(/g) ?? []).length, 2, "checker coverage includes the audited PII reveal case");

  assertPathsCovered(maintenance, ["/", "/health", "/models", "/integrations", "/integrations/sources", "/integrations/email", "/integrations/payments", "/integrations/demo-exchanges", "/settings?tab=appearance", "/configurations", "/audit", "/releases", "/ai-usage", "/work-records", "/?tab=health", "/ai-strategy?tab=models", "/integrations?tab=email", "/configurations?tab=platform", "/releases?tab=technical-audit"], "maintenance-admin-ui.spec.ts");
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

test("staff-registration browser retries use a unique identity and an explicit timeout budget", async () => {
  const identity = await source("g1-identity-security.spec.ts");
  const journey = identity.slice(
    identity.indexOf('test("Operations 权限链接'),
    identity.indexOf('test("Client 五个浏览器'),
  );
  assert.match(journey, /test\.setTimeout\(120_000\)/);
  assert.match(journey, /const attemptId = randomUUID\(\)/);
  assert.match(journey, /g1-employee-\$\{runtime\.schema\.slice\([^}]+\}-\$\{attemptId\}@quality\.invalid/);
});

test("isolated browser forwarding owns proxy requests outside browser-context route disposal", async () => {
  const support = await source("support/quality-test.ts");
  const isolatedStart = support.indexOf("export async function createIsolatedQualityBrowser");
  const fixtureSupport = support.slice(0, isolatedStart);
  const isolatedSupport = support.slice(isolatedStart);
  assert.match(fixtureSupport, /playwrightRequest\.newContext\(\)/);
  assert.match(fixtureSupport, /fixtureForwarder\.fetch\(forward\.url/);
  assert.doesNotMatch(fixtureSupport, /route\.fetch\(/);
  assert.match(fixtureSupport, /await fixtureForwarder\.dispose\(\{ reason: "quality evidence complete" \}\)/);
  assert.doesNotMatch(fixtureSupport, /context\.unrouteAll\(/);
  assert.match(isolatedSupport, /catch \(error\) \{\s*if \(closing\) return;/);
  assert.match(support, /openedPage\.on\("requestfailed", \(request\) => \{\s*if \(closing\) return;/);
  assert.match(isolatedSupport, /playwrightRequest\.newContext\(\)/);
  assert.match(isolatedSupport, /forwarder\.fetch\(forward\.url/);
  assert.doesNotMatch(isolatedSupport, /route\.fetch\(/);
  assert.match(support, /page\.goto\("about:blank", \{ waitUntil: "commit", timeout: 5_000 \}\)/);
  assert.doesNotMatch(isolatedSupport, /context\.unrouteAll\(/);
  assert.match(support, /page\.close\(\{ runBeforeUnload: false \}\)/);
  assert.match(isolatedSupport, /\(\) => forwarder\.dispose\(\{ reason: "quality evidence complete" \}\)/);
  assert.match(isolatedSupport, /\(\) => context\.close\(\{ reason: "quality evidence complete" \}\)/);
  assert.match(isolatedSupport, /for \(const cleanup of cleanupSteps\)[\s\S]*cleanupFailures\.push\(error\)/);
  assert.ok(
    isolatedSupport.indexOf('() => forwarder.dispose({ reason: "quality evidence complete" })')
      < isolatedSupport.indexOf('() => context.close({ reason: "quality evidence complete" })'),
    "the independent forwarder must cancel its requests before the browser context closes",
  );
  assert.match(support, /throw new Error\(`isolated loopback fulfill failed/);
});
