import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("page routing contract accepts only the stable routes owned by each audience", async () => {
  const { isRivertonPagePath } = await import("../app/riverton-route-contract.ts");

  for (const audience of ["client", "operations", "maintenance"]) {
    assert.equal(isRivertonPagePath(audience, "/"), true);
    assert.equal(isRivertonPagePath(audience, "/_not-found"), true);
    assert.equal(isRivertonPagePath(audience, "/login"), true);
    assert.equal(isRivertonPagePath(audience, "/reset-password"), true);
    assert.equal(isRivertonPagePath(audience, "/not-a-stable-route"), false);
    assert.equal(isRivertonPagePath(audience, "/setup"), false);
  }

  assert.equal(isRivertonPagePath("client", "/workspace"), true);
  assert.equal(isRivertonPagePath("client", "/legal/consent"), true);
  assert.equal(isRivertonPagePath("client", "/membership/orders"), true);
  assert.equal(isRivertonPagePath("client", "/paper/portfolio-1"), true);
  assert.equal(isRivertonPagePath("client", "/verify-email"), true);
  assert.equal(isRivertonPagePath("client", "/customers"), false);
  assert.equal(isRivertonPagePath("client", "/workspace/legacy"), false);
  assert.equal(isRivertonPagePath("client", "/membership/orders/extra"), false);

  assert.equal(isRivertonPagePath("operations", "/customers"), true);
  assert.equal(isRivertonPagePath("operations", "/deposits/deposit-1"), true);
  assert.equal(isRivertonPagePath("operations", "/access/audit"), true);
  assert.equal(isRivertonPagePath("operations", "/membership-orders/order-1"), true);
  assert.equal(isRivertonPagePath("operations", "/workspace"), false);
  assert.equal(isRivertonPagePath("operations", "/legal/consent"), false);
  assert.equal(isRivertonPagePath("operations", "/models"), false);
  assert.equal(isRivertonPagePath("operations", "/verify-email"), false);

  assert.equal(isRivertonPagePath("maintenance", "/models"), true);
  assert.equal(isRivertonPagePath("maintenance", "/integrations/demo-exchanges"), true);
  assert.equal(isRivertonPagePath("maintenance", "/integrations/sources"), true);
  assert.equal(isRivertonPagePath("maintenance", "/settings/disclosures"), true);
  assert.equal(isRivertonPagePath("maintenance", "/access/audit"), true);
  assert.equal(isRivertonPagePath("maintenance", "/audit"), true);
  assert.equal(isRivertonPagePath("maintenance", "/workspace"), false);
  assert.equal(isRivertonPagePath("maintenance", "/legal/consent"), false);
  assert.equal(isRivertonPagePath("maintenance", "/customers"), false);
  assert.equal(isRivertonPagePath("maintenance", "/integrations/email/extra"), false);
  assert.equal(isRivertonPagePath("operations", "/settings/disclosures"), false);
});

test("Proxy rejects invalid page routes before App Router can stream a soft 404", async () => {
  const source = await read("proxy.ts");
  assert.match(source, /isRivertonPagePath/);
  assert.match(source, /if \(!isRivertonPagePath\(audience, request\.nextUrl\.pathname\)\)/);
  assert.match(source, /destination\.pathname = "\/_not-found"/);
  assert.match(source, /NextResponse\.rewrite\(destination/);
  assert.match(source, /status:\s*404/);
});
