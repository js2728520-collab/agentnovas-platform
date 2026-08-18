import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import pg from "pg";

import { createPostgresBusinessDb } from "../db/postgres.ts";
import { exchangeAccounts, organizations, users } from "../db/schema.ts";
import { migrateLegacySqliteDatabase } from "../lib/legacy-sqlite-postgres-migration.ts";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schemaName = `business_data_test_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schemaName}`,
});
const database = createPostgresBusinessDb(pool);
let temporaryDirectory;

test.before(async () => {
  assert.match(schemaName, /^[a-z0-9_]+$/);
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  temporaryDirectory = await mkdtemp(join(tmpdir(), "agentnovas-business-cutover-"));
  const businessMigration = await readFile(new URL("../postgres/migrations/0000_business_schema.sql", import.meta.url), "utf8");
  const researchMigration = await readFile(new URL("../postgres/migrations/0001_strategy_research.sql", import.meta.url), "utf8");
  await pool.query(businessMigration);
  await pool.query(researchMigration);
  await pool.query(businessMigration);
});

test.beforeEach(async () => {
  await pool.query("TRUNCATE organizations CASCADE");
});

test.after(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  await adminPool.end();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("runs legacy Drizzle query objects on PostgreSQL and maps integer booleans", async () => {
  await database.batch([
    database.insert(users).values({
      id: "customer-a",
      email: "customer-a@example.test",
      passwordHash: "hash",
      role: "customer",
      organizationId: "org-a",
      status: "active",
    }),
    database.insert(organizations).values({ id: "org-a", type: "headquarters", name: "HQ" }),
    database.insert(exchangeAccounts).values({
      id: "account-a",
      customerId: "customer-a",
      exchange: "OKX",
      label: "Read only",
      encryptedCredentialRef: "encrypted",
      canRead: true,
      canTrade: false,
    }),
  ]);

  const account = (await database.select().from(exchangeAccounts).where(eq(exchangeAccounts.id, "account-a")))[0];
  assert.equal(account.canRead, true);
  assert.equal(account.canTrade, false);
  assert.match(account.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("rolls back the complete compatibility batch when any statement fails", async () => {
  await assert.rejects(database.batch([
    database.insert(organizations).values({ id: "rollback-org", type: "branch", name: "First" }),
    database.insert(organizations).values({ id: "rollback-org", type: "branch", name: "Duplicate" }),
  ]));

  const rows = await database.select().from(organizations).where(eq(organizations.id, "rollback-org"));
  assert.equal(rows.length, 0);
});

test("imports and verifies the complete legacy SQLite business snapshot", async () => {
  const sqlitePath = join(temporaryDirectory, "complete-legacy.sqlite");
  const source = new DatabaseSync(sqlitePath);
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(migrationDirectory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const file of files) {
    const migration = await readFile(new URL(file, migrationDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) source.exec(statement);
  }
  source.exec(`
    CREATE TABLE _agentnovas_migrations (name text PRIMARY KEY, applied_at text NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO _agentnovas_migrations (name) VALUES ('0025_strategy_research_validation');
    INSERT INTO organizations (id, type, name) VALUES ('migrated-org', 'headquarters', 'Migrated HQ');
    INSERT INTO users (id, email, password_hash, role, organization_id, status)
      VALUES ('migrated-user', 'migrated@example.test', 'hash', 'customer', 'migrated-org', 'active');
  `);
  source.close();

  const result = await migrateLegacySqliteDatabase({
    sqlitePath,
    database: pool,
    batchId: "complete-business-cutover",
    sourceRef: "legacy-sqlite-complete-fixture",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.tables.length, 41);
  assert.ok(result.tables.every(table => table.verified));
  const migrated = await database.select().from(users).where(eq(users.id, "migrated-user"));
  assert.equal(migrated[0]?.organizationId, "migrated-org");
});
