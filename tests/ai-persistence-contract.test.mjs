import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("AI persistence migration creates tenant-scoped conversations, messages, usage, and strategy versions", async () => {
  const [migration, restoreMigration] = await Promise.all([
    readFile(new URL("../drizzle/0023_ai_assistant_strategy_dsl.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0024_strategy_version_restore.sql", import.meta.url), "utf8"),
  ]);
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL)");
  database.exec("CREATE TABLE community_strategies (id TEXT PRIMARY KEY NOT NULL)");
  for (const statement of migration.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
    database.exec(statement);
  }
  database.exec(restoreMigration);

  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(tables.includes("ai_conversations"));
  assert.ok(tables.includes("ai_messages"));
  assert.ok(tables.includes("ai_usage_daily"));
  assert.ok(tables.includes("strategy_versions"));

  const messageColumns = database.prepare("PRAGMA table_info(ai_messages)").all().map((row) => row.name);
  assert.ok(messageColumns.includes("user_id"));
  assert.ok(messageColumns.includes("conversation_id"));
  assert.ok(messageColumns.includes("content"));
  const versionColumns = database.prepare("PRAGMA table_info(strategy_versions)").all().map((row) => row.name);
  assert.ok(versionColumns.includes("restored_from_version"));

  database.exec("INSERT INTO users (id) VALUES ('customer-a')");
  database.exec("INSERT INTO community_strategies (id) VALUES ('strategy-a')");
  database.exec("INSERT INTO ai_usage_daily (id, user_id, usage_date) VALUES ('u1', 'customer-a', '2026-08-16')");
  assert.throws(
    () => database.exec("INSERT INTO ai_usage_daily (id, user_id, usage_date) VALUES ('u2', 'customer-a', '2026-08-16')"),
    /UNIQUE constraint failed/,
  );
  database.exec("INSERT INTO strategy_versions (id, strategy_id, version, specification_json, restored_from_version, created_by_user_id) VALUES ('v1', 'strategy-a', 1, '{}', NULL, 'customer-a')");
  database.exec("INSERT INTO strategy_versions (id, strategy_id, version, specification_json, restored_from_version, created_by_user_id) VALUES ('v2', 'strategy-a', 2, '{}', 1, 'customer-a')");
  assert.equal(database.prepare("SELECT restored_from_version FROM strategy_versions WHERE id = 'v2'").get().restored_from_version, 1);
  assert.throws(
    () => database.exec("INSERT INTO strategy_versions (id, strategy_id, version, specification_json, created_by_user_id) VALUES ('v2', 'strategy-a', 1, '{}', 'customer-a')"),
    /UNIQUE constraint failed/,
  );
});

test("Drizzle compatibility schema and PostgreSQL migration include the AI tables", async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../postgres/migrations/0000_business_schema.sql", import.meta.url), "utf8"),
  ]);

  for (const exportName of ["aiConversations", "aiMessages", "aiUsageDaily", "strategyVersions"]) {
    assert.match(schema, new RegExp(`export const ${exportName} = sqliteTable`));
  }
  for (const tableName of ["ai_conversations", "ai_messages", "ai_usage_daily", "strategy_versions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS "${tableName}"`));
  }
  assert.match(migration, /"restored_from_version" integer/);
});
