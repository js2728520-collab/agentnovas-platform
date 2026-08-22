import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import {
  assertOperationsCustomerScope,
  assertOperationsOrderScope,
  assertOperationsStatementScope,
  commercialCustomerScopePredicate,
} from "../lib/commercial-operations-scope.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `commercial_scope_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schema}`,
});
const identity = { userId: "ops-1", organizationId: "org-a" };

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY);
    CREATE TABLE customer_attributions (
      id text PRIMARY KEY,
      customer_id text NOT NULL,
      status text NOT NULL,
      branch_id text,
      manager_id text,
      supervisor_id text,
      employee_id text
    );
    CREATE TABLE commercial_membership_orders (id text PRIMARY KEY, user_id text NOT NULL);
    CREATE TABLE performance_fee_statements (id text PRIMARY KEY, user_id text NOT NULL);
    INSERT INTO users (id) VALUES
      ('ops-1'),('customer-direct'),('customer-manager'),('customer-supervisor'),
      ('customer-org-a'),('customer-cross'),('customer-inactive'),('customer-unassigned');
    INSERT INTO customer_attributions
      (id,customer_id,status,branch_id,manager_id,supervisor_id,employee_id)
    VALUES
      ('a-self','ops-1','active','org-a',NULL,NULL,NULL),
      ('a-direct','customer-direct','active','org-a',NULL,NULL,'ops-1'),
      ('a-manager','customer-manager','active','org-a','ops-1',NULL,NULL),
      ('a-supervisor','customer-supervisor','active','org-a',NULL,'ops-1',NULL),
      ('a-org','customer-org-a','active','org-a',NULL,NULL,NULL),
      ('a-cross','customer-cross','active','org-b',NULL,NULL,'ops-1'),
      ('a-inactive','customer-inactive','ended','org-a',NULL,NULL,'ops-1');
    INSERT INTO commercial_membership_orders (id,user_id) VALUES
      ('o-self','ops-1'),
      ('o-direct','customer-direct'),
      ('o-manager','customer-manager'),
      ('o-supervisor','customer-supervisor'),
      ('o-org','customer-org-a'),
      ('o-cross','customer-cross'),
      ('o-inactive','customer-inactive'),
      ('o-unassigned','customer-unassigned');
    INSERT INTO performance_fee_statements (id,user_id) VALUES
      ('s-org','customer-org-a'),
      ('s-cross','customer-cross');
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.end();
});

async function visible(scope, organizationIds) {
  const predicate = commercialCustomerScopePredicate(
    scope,
    identity,
    "scope_order",
    "o.user_id",
    1,
    organizationIds,
  );
  const result = await pool.query(
    `SELECT o.id FROM commercial_membership_orders o WHERE ${predicate.clause} ORDER BY o.id`,
    predicate.values,
  );
  return result.rows.map((row) => row.id);
}

test("Postgres commercial predicates enforce SELF, DIRECT, TEAM, organization set, and active attribution", async () => {
  assert.deepEqual(await visible("SELF", ["org-a"]), ["o-self"]);
  assert.deepEqual(await visible("DIRECT_REPORTS", ["org-a"]), ["o-direct"]);
  assert.deepEqual(await visible("TEAM_TREE", ["org-a"]), [
    "o-direct",
    "o-manager",
    "o-supervisor",
  ]);
  assert.deepEqual(await visible("ORGANIZATION", ["org-a"]), [
    "o-direct",
    "o-manager",
    "o-org",
    "o-self",
    "o-supervisor",
  ]);
  assert.deepEqual(await visible("ORGANIZATION_SET", ["org-a", "org-b"]), [
    "o-cross",
    "o-direct",
    "o-manager",
    "o-org",
    "o-self",
    "o-supervisor",
  ]);
  assert.deepEqual(await visible("PLATFORM", []), [
    "o-cross",
    "o-direct",
    "o-inactive",
    "o-manager",
    "o-org",
    "o-self",
    "o-supervisor",
    "o-unassigned",
  ]);
});

test("unknown and out-of-scope commercial targets share the same 404", async () => {
  const rejected = [];
  for (const target of ["customer-cross", "customer-unknown"]) {
    try {
      await assertOperationsCustomerScope(
        pool,
        "ORGANIZATION_SET",
        identity,
        target,
        ["org-a"],
      );
      assert.fail("scope assertion unexpectedly passed");
    } catch (error) {
      rejected.push({ code: error.code, status: error.status, message: error.message });
    }
  }
  assert.deepEqual(rejected[0], rejected[1]);
  assert.deepEqual(rejected[0], {
    code: "RESOURCE_NOT_FOUND",
    status: 404,
    message: "资源不存在或不在当前数据范围",
  });

  await assertOperationsOrderScope(
    pool,
    "ORGANIZATION_SET",
    identity,
    "o-org",
    ["org-a"],
  );
  await assertOperationsStatementScope(
    pool,
    "ORGANIZATION_SET",
    identity,
    "s-org",
    ["org-a"],
  );
  await assertOperationsCustomerScope(
    pool,
    "PLATFORM",
    { userId: "platform-admin", organizationId: null },
    "customer-unassigned",
    [],
  );
  await assertOperationsOrderScope(
    pool,
    "PLATFORM",
    { userId: "platform-admin", organizationId: null },
    "o-unassigned",
    [],
  );
  for (const assertion of [
    () => assertOperationsOrderScope(pool, "ORGANIZATION_SET", identity, "o-cross", ["org-a"]),
    () => assertOperationsOrderScope(pool, "ORGANIZATION_SET", identity, "missing", ["org-a"]),
    () => assertOperationsStatementScope(pool, "ORGANIZATION_SET", identity, "s-cross", ["org-a"]),
    () => assertOperationsStatementScope(pool, "ORGANIZATION_SET", identity, "missing", ["org-a"]),
  ]) {
    await assert.rejects(
      assertion(),
      (error) => error.code === "RESOURCE_NOT_FOUND" && error.status === 404,
    );
  }
});

test("same-client scope resolution holds attribution locks across a mutation transaction", async () => {
  const resolverClient = await pool.connect();
  const competingClient = await pool.connect();
  try {
    await resolverClient.query("BEGIN");
    await assertOperationsOrderScope(
      resolverClient,
      "ORGANIZATION_SET",
      identity,
      "o-direct",
      ["org-a"],
    );
    await competingClient.query("SET lock_timeout='100ms'");
    await assert.rejects(
      competingClient.query(
        `UPDATE customer_attributions SET branch_id='org-b' WHERE id='a-direct'`,
      ),
      /lock timeout/i,
    );
  } finally {
    await resolverClient.query("ROLLBACK");
    resolverClient.release();
    competingClient.release();
  }
});
