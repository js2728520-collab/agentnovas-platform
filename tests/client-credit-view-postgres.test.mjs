import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

import { readClientCreditBalance } from "../lib/client-credit-view.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `client_credit_${process.pid}_${Date.now()}`;
const clientRole = `agentnovas_credit_reader_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, options: `-c search_path=${schema}` });

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY, created_at text NOT NULL);
    CREATE TABLE ai_credit_accounts (
      id text PRIMARY KEY, user_id text NOT NULL, available_credits numeric NOT NULL,
      reserved_credits numeric NOT NULL, version bigint NOT NULL, updated_at timestamptz NOT NULL
    );
    CREATE TABLE ai_credit_ledger_entries (
      id text PRIMARY KEY, account_id text NOT NULL, entry_type text NOT NULL,
      available_delta numeric NOT NULL, reserved_delta numeric NOT NULL
    );
    INSERT INTO users VALUES ('without-account','2026-08-20T00:00:00.000Z');
    INSERT INTO users VALUES ('with-account','2026-08-19T00:00:00.000Z');
    INSERT INTO ai_credit_accounts VALUES ('account-1','with-account',900,10,4,'2026-08-21T00:00:00Z');
    INSERT INTO ai_credit_ledger_entries VALUES
      ('grant-1','account-1','grant',1000,0),
      ('settle-1','account-1','settle',-100,0);
  `);
  await adminPool.query(`CREATE ROLE "${clientRole}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
  await pool.query(`
    GRANT USAGE ON SCHEMA "${schema}" TO "${clientRole}";
    GRANT SELECT ON ai_credit_accounts,ai_credit_ledger_entries TO "${clientRole}";
    REVOKE ALL ON users FROM "${clientRole}";
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE users FORCE ROW LEVEL SECURITY;
    CREATE POLICY users_denied_to_credit_reader ON users AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
  `);
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await adminPool.query(`DROP ROLE "${clientRole}"`);
  await adminPool.end();
});

test("client credit balance never depends on direct users table access", async () => {
  const connection = await pool.connect();
  try {
    await connection.query(`SET ROLE "${clientRole}"`);
    const reader = { query: connection.query.bind(connection) };
    assert.deepEqual(await readClientCreditBalance(reader, "without-account"), {
      available: "0", reserved: "0", lifetimeGranted: "0", lifetimeConsumed: "0",
      version: "0", updatedAt: null,
    });
    assert.deepEqual(await readClientCreditBalance(reader, "with-account"), {
      available: "900", reserved: "10", lifetimeGranted: "1000", lifetimeConsumed: "100",
      version: "4", updatedAt: "2026-08-21T00:00:00.000Z",
    });
  } finally {
    await connection.query("RESET ROLE");
    connection.release();
  }
});
