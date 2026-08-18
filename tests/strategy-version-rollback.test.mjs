import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("rollback creates a new immutable version from an owned historical snapshot", async () => {
  const route = await readFile(
    new URL("../app/api/strategy-marketplace/[id]/versions/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /requireUser\(request, \["customer"\]\)/);
  assert.match(route, /eq\(communityStrategies\.authorUserId, me\.id\)/);
  assert.match(route, /eq\(strategyVersions\.strategyId, id\)/);
  assert.match(route, /Number\.isInteger\(sourceVersion\)/);
  assert.match(route, /normalizeStrategyDsl/);
  assert.match(route, /const nextVersion = current\.version \+ 1/);
  assert.match(route, /insert\(strategyVersions\)/);
  assert.match(route, /restoredFromVersion: sourceVersion/);
  assert.match(route, /action: "strategy\.version\.restored"/);
  assert.match(route, /version: nextVersion/);
});

test("rollback preserves protected strategy states and records its provenance", async () => {
  const [route, schema, migration, registry] = await Promise.all([
    readFile(new URL("../app/api/strategy-marketplace/[id]/versions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0024_strategy_version_restore.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/d1-migrations.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /\["draft", "testing", "rejected"\]/);
  assert.match(route, /当前版本无需回滚/);
  assert.match(route, /restoredFromVersion: sourceVersion/);
  assert.match(schema, /restoredFromVersion: integer\("restored_from_version"\)/);
  assert.match(migration, /ALTER TABLE `strategy_versions` ADD `restored_from_version` integer/);
  assert.match(registry, /0024_strategy_version_restore/);
});

test("strategy history UI exposes an explicit version restore action", async () => {
  const detail = await readFile(new URL("../app/strategy-backtest-detail.tsx", import.meta.url), "utf8");

  assert.match(detail, /restoredFromVersion/);
  assert.match(detail, /rollbackVersion/);
  assert.match(detail, /\/versions/);
  assert.match(detail, /回滚到 V/);
  assert.match(detail, /将生成新的 V/);
  assert.match(detail, /当前版本/);
});
