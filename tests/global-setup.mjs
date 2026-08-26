import pg from "pg";

import {
  newTestRunToken,
  sweepTestRoles,
  TEST_ROLE_RUN_KEY,
} from "./helpers/postgres-global-roles.mjs";

// PostgreSQL roles are cluster-global, so a role dropped by one test file's teardown can
// vanish out from under another file's migration chain while it converges ACLs over
// pg_roles. The suite avoids that by never dropping a role while it runs: fixtures leave
// their roles in place and cleanup happens here, before the first test process starts and
// after the last one exits. See tests/helpers/postgres-global-roles.mjs.
//
// The sweep is scoped by run token, so a second suite running against the same cluster
// keeps its roles — only this run's, and roles abandoned by a crashed run, are dropped.
const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";

async function sweep(phase) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { dropped, stuck } = await sweepTestRoles(pool);
    if (dropped) console.log(`[test roles] ${phase}: dropped ${dropped} test role(s)`);
    for (const reason of stuck) console.warn(`[test roles] ${phase}: could not drop ${reason}`);
  } catch (error) {
    // The suite still runs without PostgreSQL; the tests that need it report that
    // themselves. A sweep that cannot connect must not be the thing that fails the run.
    console.warn(`[test roles] ${phase}: skipped (${error.message.trim()})`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function globalSetup() {
  // Set before the first sweep so it, and every test process spawned after it, share one
  // run token.
  process.env[TEST_ROLE_RUN_KEY] = newTestRunToken();
  await sweep("before");
}

export async function globalTeardown() {
  await sweep("after");
}
