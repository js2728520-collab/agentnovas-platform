import { randomBytes } from "node:crypto";

import { POSTGRES_MIGRATION_LOCK_KEY } from "../../scripts/postgres-migration-runner.mjs";

// PostgreSQL schemas isolate the fixtures of parallel test files; roles do not.
// `CREATE ROLE`/`DROP ROLE` mutate one cluster-wide catalog that the whole suite shares.
//
// Several migrations converge their ACLs by reading that catalog and then acting on the
// names they read: 0043 and 0072 loop over `pg_roles` and REVOKE from every role, and
// 0063/0066/0076-0080 check `IF EXISTS (SELECT 1 FROM pg_roles ...)` and then GRANT. A
// role dropped in between fails the statement with 42704 `role "..." does not exist`,
// and an unrelated test file's whole migration chain rolls back with it. Those
// migrations are applied, so their checksums are frozen and the guard cannot be added
// there.
//
// Guarding the reading side is not practical either — around two dozen test files apply
// those migrations straight through `pool.query`, not through the migration runner. So
// the guard is on the writing side, and it is a scheduling rule rather than a lock:
// **no role is dropped while the suite is running.** tests/global-setup.mjs sweeps
// before the first test file starts and again after the last one exits, and
// `dropTestRole` stands down in between. A role that merely exists is harmless — the
// convergence loops revoke from it and move on.
export const TEST_ROLE_PREFIX = "agentnovas_test_";

// Set by tests/global-setup.mjs and inherited by every test process it spawns. Its
// presence means the suite-level sweep owns cleanup; its value scopes that sweep to the
// roles of this run, so a second suite running against the same cluster is left alone.
export const TEST_ROLE_RUN_KEY = "AGENTNOVAS_TEST_ROLE_RUN";

// How long a role from some other run may sit in the catalog before a sweep treats it as
// the leftover of a crashed process. A full suite run is seconds; an hour is far outside
// anything a live run can still be holding.
export const STALE_TEST_ROLE_MS = 60 * 60 * 1000;

const VALID_ROLE = /^[a-z0-9_]+$/;
const MAX_IDENTIFIER_BYTES = 63;

export function newTestRunToken() {
  return randomBytes(4).toString("hex");
}

export function currentTestRunToken() {
  return process.env[TEST_ROLE_RUN_KEY] || "";
}

// `<prefix><purpose>_<run token>_<created at>`. The run token scopes the sweep and the
// trailing epoch dates the role, so a sweep can tell "mine", "someone else's, live" and
// "someone else's, abandoned" apart without a catalog timestamp, which PostgreSQL does
// not keep for roles.
export function testRoleName(purpose) {
  const runToken = currentTestRunToken() || `p${process.pid}`;
  const role = `${TEST_ROLE_PREFIX}${purpose}_${runToken}_${Date.now()}`;
  // PostgreSQL truncates identifiers at 63 bytes; a truncated role name would silently
  // collide with another fixture's.
  if (!VALID_ROLE.test(role) || Buffer.byteLength(role) > MAX_IDENTIFIER_BYTES) {
    throw new Error(`Unusable PostgreSQL test role name: ${role}`);
  }
  return role;
}

export async function createTestRole(pool, role, attributes = "NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT") {
  await withGlobalRoleLock(pool, (client) =>
    client.query(`CREATE ROLE ${quotedTestRole(role)} ${attributes}`));
}

// Only drops when nothing else can be mid-convergence: either the suite-level sweep owns
// cleanup (then this does nothing and the sweep drops the role once every test process
// has exited), or this is a hand-run file and the advisory lock covers the rest.
export async function dropTestRole(pool, role) {
  if (currentTestRunToken()) return;
  await withGlobalRoleLock(pool, (client) => client.query(`DROP ROLE ${quotedTestRole(role)}`));
}

// Pure so the "never touch a concurrent run" rule is testable without a cluster.
export function selectSweepableRoles(roleNames, { runToken, now = Date.now(), staleMs = STALE_TEST_ROLE_MS } = {}) {
  return roleNames.filter((role) => {
    if (!role.startsWith(TEST_ROLE_PREFIX)) return false;
    if (runToken && role.includes(`_${runToken}_`)) return true;
    const createdAt = Number(role.slice(role.lastIndexOf("_") + 1));
    // A name that does not carry a readable epoch cannot be dated, so it is only ever
    // swept as this run's own. Leaving it is the safe direction.
    if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
    return now - createdAt > staleMs;
  });
}

// Drops this run's roles plus anything abandoned by a crashed one. The login/superuser
// exclusions keep a mistyped production role out of reach even if it carried the prefix.
export async function sweepTestRoles(pool, { runToken = currentTestRunToken(), now, staleMs } = {}) {
  const roles = await pool.query(
    `SELECT rolname FROM pg_roles
      WHERE rolname LIKE $1 || '%' AND NOT rolcanlogin AND NOT rolsuper
      ORDER BY rolname`,
    [TEST_ROLE_PREFIX],
  );
  const sweepable = selectSweepableRoles(roles.rows.map((row) => row.rolname), { runToken, now, staleMs });
  const stuck = [];
  for (const role of sweepable) {
    try {
      // A crashed run leaves both its role and its schema behind, and the grants that
      // schema still holds block DROP ROLE. These roles own nothing, so DROP OWNED BY
      // only clears those grants — it does not delete the fixture schema itself.
      await pool.query(`DROP OWNED BY ${quotedTestRole(role)}`);
      await pool.query(`DROP ROLE ${quotedTestRole(role)}`);
    } catch (error) {
      stuck.push(`${role}: ${error.message.trim()}`);
    }
  }
  return { dropped: sweepable.length - stuck.length, stuck };
}

// Advisory locks are per-database while roles are per-cluster, so this only serializes
// against work in the coordination database — the one in TEST_DATABASE_URL, where the
// suite does all of its role DDL and all but one of its migration chains. A chain applied
// to a database of its own (tests/live-book-posting-postgres.test.mjs) has to take this
// lock explicitly on the coordination database.
export async function withGlobalRoleLock(pool, run) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [POSTGRES_MIGRATION_LOCK_KEY]);
    try {
      return await run(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [POSTGRES_MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

function quotedTestRole(role) {
  if (!role.startsWith(TEST_ROLE_PREFIX) || !VALID_ROLE.test(role)) {
    throw new Error(`Refusing role DDL outside the test namespace: ${role}`);
  }
  return `"${role}"`;
}
