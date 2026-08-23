import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  cleanupQualityDatabaseFixture,
  prepareQualityDatabaseFixture,
} from "../scripts/quality/quality-database-fixture.mjs";
import { loadOperationsCustomerPii } from "../lib/operations-customer-pii-service.ts";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `quality_e2e_pii_${process.pid}_${Date.now()}`.slice(0, 54);

test("customer PII loader stays compatible with the complete migrated quality schema", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "agentnovas-pii-fixture-"));
  let prepared = false;
  try {
    const fixture = await prepareQualityDatabaseFixture({ adminDatabaseUrl, schema, outputDirectory });
    prepared = true;
    const pool = new pg.Pool({ connectionString: fixture.applicationDatabaseUrl, max: 1 });
    try {
      const result = await loadOperationsCustomerPii(pool, [fixture.identities.client.userId]);
      assert.ok(result.has(fixture.identities.client.userId));
    } finally {
      await pool.end();
    }
  } finally {
    if (prepared) await cleanupQualityDatabaseFixture({ adminDatabaseUrl, schema });
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
