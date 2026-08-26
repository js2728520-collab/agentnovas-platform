import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  selectSweepableRoles,
  STALE_TEST_ROLE_MS,
  TEST_ROLE_PREFIX,
  testRoleName,
} from "./helpers/postgres-global-roles.mjs";

test("the default test suite never imports ignored build output", async () => {
  const renderedSuite = await readFile(new URL("./rendered-html.test.mjs", import.meta.url), "utf8");
  const ignoredOutputPattern = new RegExp(["dist", "server", "index\\.js"].join("[/\\\\]+"));
  assert.doesNotMatch(renderedSuite, ignoredOutputPattern);
});

test("package scripts describe separate logic, app-build and runtime-smoke gates", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.test, /test:all/);
  assert.match(packageJson.scripts["test:apps"], /build:client/);
  assert.match(packageJson.scripts["test:smoke"], /build:client/);
  assert.match(packageJson.scripts["test:smoke"], /smoke-next-render/);
});

test("the production smoke maps its random port to the explicit client audience", async () => {
  const smokeScript = await readFile(new URL("../scripts/smoke-next-render.mjs", import.meta.url), "utf8");

  assert.match(smokeScript, /RIVERTON_APP_AUDIENCE:\s*["']client["']/);
  assert.match(smokeScript, /RIVERTON_APP_LOCAL_PORT:\s*String\(port\)/);
  assert.match(smokeScript, /正在验证客户端会话/);
  assert.doesNotMatch(smokeScript, /交易大厅\|Trading Hall/);
});

// PostgreSQL schemas isolate the fixtures of parallel test files; roles do not.
// Migrations 0043 and 0072 converge their gateway ACLs by looping over pg_roles and
// revoking from every role they find, and 0063/0066/0076-0080 read pg_roles and then
// grant to the names they read. A role dropped between that read and the statement
// naming it fails with 42704 and rolls back an unrelated file's migration chain. Those
// migrations are applied, so their checksums are frozen and the guard lives on the test
// side: role DDL goes through tests/helpers/postgres-global-roles.mjs, which keeps every
// role alive until the suite-level sweep runs.
test("cluster-global role DDL in tests goes through the serialized helper", async () => {
  const directory = new URL("./", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".test.mjs"));
  assert.ok(names.length > 100, "the test directory listing resolved");

  const offenders = [];
  for (const name of names) {
    const source = await readFile(new URL(name, directory), "utf8");
    // Only the executable form — a role statement opening a SQL string literal.
    // Source-text assertions that quote a role statement inside a regex stay allowed.
    if (/["'`]\s*(?:CREATE|DROP)\s+ROLE\b/i.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "these files run role DDL outside tests/helpers/postgres-global-roles.mjs");
});

test("the suite sweeps its cluster-global roles instead of dropping them mid-run", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts["test:all"], /--test-global-setup=tests\/global-setup\.mjs/);

  const setup = await readFile(new URL("./global-setup.mjs", import.meta.url), "utf8");
  assert.match(setup, /export async function globalSetup\(/);
  assert.match(setup, /export async function globalTeardown\(/);
  assert.match(setup, /sweepTestRoles/);
  // The run token globalSetup exports is what makes fixture teardown stand down, and
  // what keeps this run's sweep off a concurrent run's roles.
  assert.match(setup, /process\.env\[TEST_ROLE_RUN_KEY\] = newTestRunToken\(\)/);

  const helper = await readFile(new URL("./helpers/postgres-global-roles.mjs", import.meta.url), "utf8");
  assert.match(helper, /export const TEST_ROLE_RUN_KEY = "AGENTNOVAS_TEST_ROLE_RUN";/);
  assert.match(helper, /export const TEST_ROLE_PREFIX = "agentnovas_test_";/);
  // The sweep is only safe because it cannot reach a login or superuser role.
  assert.match(helper, /NOT rolcanlogin AND NOT rolsuper/);
});

test("a sweep drops its own run and abandoned runs, never a live concurrent one", () => {
  const now = 1_800_000_000_000;
  const fresh = (token, ageMs) => `${TEST_ROLE_PREFIX}reader_${token}_${now - ageMs}`;

  const mine = fresh("aaaa1111", 500);
  const concurrent = fresh("bbbb2222", 500);
  const abandoned = fresh("cccc3333", STALE_TEST_ROLE_MS + 1);
  const standalone = `${TEST_ROLE_PREFIX}reader_p4242_${now - 500}`;
  const foreign = "agentnovas_client_web";
  const undatable = `${TEST_ROLE_PREFIX}reader_bbbb2222_notanepoch`;

  assert.deepEqual(
    selectSweepableRoles([mine, concurrent, abandoned, standalone, foreign, undatable], { runToken: "aaaa1111", now }),
    [mine, abandoned],
  );

  // No run token (a hand-run sweep) must still leave every live run alone.
  assert.deepEqual(
    selectSweepableRoles([mine, concurrent, abandoned], { runToken: "", now }),
    [abandoned],
  );
});

test("test role names stay inside PostgreSQL's identifier limit", () => {
  const longest = testRoleName("identity_client_auth");
  assert.match(longest, /^agentnovas_test_identity_client_auth_p?[a-z0-9]+_\d+$/);
  // PostgreSQL truncates at 63 bytes, and a truncated name collides with another fixture.
  assert.ok(Buffer.byteLength(longest) <= 63, `${longest} is ${Buffer.byteLength(longest)} bytes`);
});

// Advisory locks are per-database; roles are per-cluster. A chain applied to a database
// of its own does not meet the role DDL the rest of the suite serializes in the
// coordination database, so it has to take the lock there explicitly.
test("a migration chain run outside the coordination database takes the role lock", async () => {
  const directory = new URL("./", import.meta.url);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".test.mjs"));
  const unguarded = [];
  for (const name of names) {
    const source = await readFile(new URL(name, directory), "utf8");
    const leavesCoordinationDatabase = /CREATE DATABASE|apply-postgres-migrations/.test(source);
    if (leavesCoordinationDatabase && !source.includes("withGlobalRoleLock")) unguarded.push(name);
  }
  assert.deepEqual(unguarded, [], "these files migrate their own database without the coordination lock");
});

test("the role helper and the migration runner share one advisory lock", async () => {
  const helper = await readFile(new URL("./helpers/postgres-global-roles.mjs", import.meta.url), "utf8");
  assert.match(helper, /POSTGRES_MIGRATION_LOCK_KEY/);
  assert.match(helper, /pg_advisory_lock\(hashtext\(\$1\)\)/);
  assert.match(helper, /pg_advisory_unlock\(hashtext\(\$1\)\)/);

  const runner = await readFile(new URL("../scripts/postgres-migration-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /export const POSTGRES_MIGRATION_LOCK_KEY = "agentnovas:postgres-migrations:v1";/);
  assert.match(runner, /pg_advisory_lock\(hashtext\(\$1\)\)", \[POSTGRES_MIGRATION_LOCK_KEY\]/);
});
