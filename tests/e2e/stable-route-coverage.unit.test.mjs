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

test("the fixed 12-case browser suite covers every stable Client beta page", async () => {
  const contents = await source("client-ui.spec.ts");
  assertPathsCovered(contents, [
    "/",
    "/membership",
    "/membership/orders",
    "/credits",
    "/paper",
    "/trading-hall",
    "/performance-statements",
    "/wallet",
    "/wallet/deposits",
    "/notifications",
    "/account/security",
    "/support",
  ], "client-ui.spec.ts");
  assert.match(contents, /expectAudienceNavigation\(page,\s*"client"\)/);
  assert.equal((contents.match(/\btest\(/g) ?? []).length, 3, "Client coverage must remain folded into three release-gate cases");
});

test("Operations and Maintenance cases cover representative stable pages and audience-menu isolation", async () => {
  const maker = await source("operations-maker-ui.spec.ts");
  const checker = await source("operations-checker-ui.spec.ts");
  const maintenance = await source("maintenance-admin-ui.spec.ts");

  assertPathsCovered(maker, ["/customers", "/organization", "/membership-orders", "/performance-statements", "/credits", "/deposits", "/ledger", "/finance"], "operations-maker-ui.spec.ts");
  assertPathsCovered(checker, ["/", "/approvals"], "operations-checker-ui.spec.ts");
  assert.match(`${maker}\n${checker}`, /expectAudienceNavigation\(page,\s*"operations"\)/);
  assert.equal((maker.match(/\btest\(/g) ?? []).length, 2);
  assert.equal((checker.match(/\btest\(/g) ?? []).length, 1);

  assertPathsCovered(maintenance, ["/", "/health", "/models", "/integrations", "/integrations/email", "/integrations/payments", "/integrations/demo-exchanges", "/audit"], "maintenance-admin-ui.spec.ts");
  assert.match(maintenance, /expectAudienceNavigation\(page,\s*"maintenance"\)/);
  assert.equal((maintenance.match(/\btest\(/g) ?? []).length, 2);
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
