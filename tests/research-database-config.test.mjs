import assert from "node:assert/strict";
import test from "node:test";

import { researchDatabaseMaxUses, researchDatabaseUrl } from "../lib/postgres.ts";

test("uses a dedicated research database without switching the business database", () => {
  assert.equal(researchDatabaseUrl({
    RESEARCH_DATABASE_URL: "  postgresql://research-only  ",
    DATABASE_URL: "postgresql://business-cutover",
  }), "postgresql://research-only");
});

test("keeps DATABASE_URL as the production cutover fallback", () => {
  assert.equal(researchDatabaseUrl({ DATABASE_URL: " postgresql://production " }), "postgresql://production");
  assert.equal(researchDatabaseUrl({}), "");
});

test("can disable PostgreSQL connection reuse for request-scoped runtimes", () => {
  assert.equal(researchDatabaseMaxUses({ RESEARCH_DATABASE_MAX_USES: "1" }), 1);
  assert.equal(researchDatabaseMaxUses({ RESEARCH_DATABASE_MAX_USES: "25" }), 25);
  assert.equal(researchDatabaseMaxUses({ RESEARCH_DATABASE_MAX_USES: "0" }), undefined);
  assert.equal(researchDatabaseMaxUses({ RESEARCH_DATABASE_MAX_USES: "invalid" }), undefined);
  assert.equal(researchDatabaseMaxUses({}), undefined);
});
