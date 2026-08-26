import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  assertRoundBindingConsistency,
  loadMarketSourceBinding,
  pinMarketSourceBinding,
} from "../lib/market-source-binding-repository.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `market_source_binding_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;

async function copyMigrations(maximumVersion) {
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    const version = Number(name.slice(0, 4));
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name) || version > maximumVersion) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
}

const binding = (overrides = {}) => ({
  contractVersion: 1,
  strategyVersionId: "version-a",
  selectionMode: "independent",
  accountId: null,
  providerId: "exchange-binance",
  marketId: "crypto-global",
  instrumentId: "BTCUSDT",
  providerSymbol: "BTCUSDT",
  requestedUsage: "research",
  authorization: "licensed",
  capabilityVersionId: "capability-1",
  sourceAccountId: null,
  authorizesOrders: false,
  fingerprintVersion: 1,
  sourcePolicyFingerprint: "a".repeat(64),
  bindingInstanceFingerprint: "b".repeat(64),
  ...overrides,
});

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-binding-migrations-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // 0078 会把既有部署回填成 legacy_unpinned，因此夹具必须先落库。
  await copyMigrations(77);
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "binding-n-minus-one",
  });

  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('customer-a','bind-a@quality.invalid','test-only-hash','customer','active'),
      ('customer-b','bind-b@quality.invalid','test-only-hash','customer','active'),
      ('customer-c','bind-c@quality.invalid','test-only-hash','customer','active');
    INSERT INTO memberships(id,customer_id,plan_code,status) VALUES
      ('membership-a','customer-a','fixture','active'),
      ('membership-b','customer-b','fixture','active'),
      ('membership-c','customer-c','fixture','active');
    INSERT INTO official_paper_portfolios(id,membership_id,customer_id,strategy_code,risk_json) VALUES
      ('portfolio-a','membership-a','customer-a','ai_conservative','{}'),
      ('portfolio-b','membership-b','customer-b','ai_conservative','{}'),
      ('portfolio-c','membership-c','customer-c','ai_conservative','{}');
    INSERT INTO community_strategies(id,author_user_id,name) VALUES
      ('strategy-a','customer-a','Fixture A'),
      ('strategy-b','customer-b','Fixture B');
    INSERT INTO strategy_versions(id,strategy_id,version,specification_json,created_by_user_id) VALUES
      ('version-a','strategy-a',1,'{}','customer-a'),
      ('version-b','strategy-b',1,'{}','customer-b');
    INSERT INTO strategy_subscriptions(
      id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,runtime_status
    ) VALUES
      ('subscription-a','strategy-a','customer-a','active','2026-08-01T00:00:00Z','version-a','paper','active'),
      ('subscription-b','strategy-b','customer-b','active','2026-08-01T00:00:00Z','version-b','paper','active');
    INSERT INTO platform_strategy_migration_map(
      strategy_code,symbol,strategy_id,strategy_version_id,conversion_contract_sha256
    ) VALUES
      ('ai_conservative','BTCUSDT','strategy-a','version-a',repeat('a',64)),
      ('ai_conservative','ETHUSDT','strategy-b','version-b',repeat('b',64));
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,strategy_subscription_id,
      exchange_account_id,mode,status,validation_label,idempotency_key,
      execution_product,platform_strategy_code,membership_id,paper_portfolio_id
    ) VALUES
      ('deployment-a','customer-a','strategy-a','version-a','subscription-a',NULL,'paper','active','UNVERIFIED','bind-a','spot_usdt','ai_conservative','membership-a','portfolio-a'),
      ('deployment-b','customer-b','strategy-b','version-b','subscription-b',NULL,'paper','active','UNVERIFIED','bind-b','spot_usdt','ai_conservative','membership-b','portfolio-b');
  `);

  await copyMigrations(78);
  const upgraded = await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "binding-current",
  });
  assert.deepEqual(upgraded.applied, ["0078_strategy_market_source_bindings.sql"]);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("历史部署回填为 legacy_unpinned，而不是编一个绑定", async () => {
  const legacy = await loadMarketSourceBinding(pool, {
    deploymentId: "deployment-a", strategyVersionId: "version-a",
  });
  assert.ok(legacy);
  // 这些部署当初没有源选择的概念。假绑定会让「这一轮用的哪个源」得到一个看似确定的
  // 错误答案；全零 fingerprint 配合 pinning 一起表达「这不是真解析结果」。
  assert.equal(legacy.pinning, "legacy_unpinned");
  assert.equal(legacy.sourcePolicyFingerprint, "0".repeat(64));
  assert.equal(legacy.capabilityVersionId, "legacy-unpinned");
});

test("legacy_unpinned 可以补成 pinned，且必须带真实 fingerprint", async () => {
  const pinned = await pinMarketSourceBinding(pool, {
    deploymentId: "deployment-a",
    ownerUserId: "customer-a",
    marketId: "crypto-global",
    instrumentId: "BTCUSDT",
    binding: binding(),
  });
  assert.equal(pinned.pinning, "pinned");
  assert.equal(pinned.sourcePolicyFingerprint, "a".repeat(64));
  assert.equal(pinned.providerId, "exchange-binance");

  const reloaded = await loadMarketSourceBinding(pool, {
    deploymentId: "deployment-a", strategyVersionId: "version-a",
  });
  assert.equal(reloaded.pinning, "pinned");
});

test("相同解析重放同一行；不同解析冲突而不是覆盖", async () => {
  const replayed = await pinMarketSourceBinding(pool, {
    deploymentId: "deployment-a",
    ownerUserId: "customer-a",
    marketId: "crypto-global",
    instrumentId: "BTCUSDT",
    binding: binding(),
  });
  assert.equal(replayed.bindingInstanceFingerprint, "b".repeat(64));

  // 覆盖等于事后改写「这一轮依据的是哪个数据源」，决策轮证据链就断了。
  await assert.rejects(
    pinMarketSourceBinding(pool, {
      deploymentId: "deployment-a",
      ownerUserId: "customer-a",
      marketId: "crypto-global",
      instrumentId: "BTCUSDT",
      binding: binding({ providerId: "exchange-okx", bindingInstanceFingerprint: "c".repeat(64) }),
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "MARKET_SOURCE_BINDING_CONFLICT");
      return true;
    },
  );

  // 原绑定不受失败影响。
  const unchanged = await loadMarketSourceBinding(pool, {
    deploymentId: "deployment-a", strategyVersionId: "version-a",
  });
  assert.equal(unchanged.providerId, "exchange-binance");
});

test("数据库层拒绝任意改写与删除", async () => {
  await assert.rejects(
    pool.query("UPDATE strategy_market_source_bindings SET provider_id='exchange-okx' WHERE deployment_id='deployment-a'"),
    (error) => /MARKET_SOURCE_BINDING_IMMUTABLE/.test(error.message),
    "已固定的绑定不得被改写",
  );
  await assert.rejects(
    pool.query("DELETE FROM strategy_market_source_bindings WHERE deployment_id='deployment-a'"),
    (error) => /MARKET_SOURCE_BINDING_IMMUTABLE/.test(error.message),
    "绑定不得被删除",
  );
  // 反向改写（pinned → legacy_unpinned）同样禁止：那等于抹掉解析事实。
  await assert.rejects(
    pool.query("UPDATE strategy_market_source_bindings SET pinning='legacy_unpinned' WHERE deployment_id='deployment-a'"),
    (error) => /MARKET_SOURCE_BINDING_IMMUTABLE/.test(error.message),
  );
});

test("共享决策轮的绑定分叉被检出，legacy 记录不参与判定", async () => {
  // 同一张卡、同一品种、同一策略版本上只有一个已固定绑定时是一致的。
  const single = await assertRoundBindingConsistency(pool, {
    strategyCode: "ai_conservative", symbol: "BTCUSDT", strategyVersionId: "version-a",
  });
  assert.equal(single.consistent, true);
  assert.equal(single.sourcePolicyFingerprint, "a".repeat(64));
  assert.equal(single.deploymentCount, 1);

  // 再加一个用不同源的部署——ADR-0018 的决策轮身份不含数据源，因此这时同一轮会拿
  // A 源的判断解释 B 源的行情。Runtime 必须在这里失败关闭，而不是悄悄共享一轮。
  await pool.query(`
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,strategy_subscription_id,
      exchange_account_id,mode,status,validation_label,idempotency_key,
      execution_product,platform_strategy_code,membership_id,paper_portfolio_id
    ) VALUES ('deployment-c','customer-c','strategy-a','version-a','subscription-b',NULL,'paper','active',
      'UNVERIFIED','bind-c','spot_usdt','ai_conservative','membership-c','portfolio-c')
  `);
  await pinMarketSourceBinding(pool, {
    deploymentId: "deployment-c",
    ownerUserId: "customer-c",
    marketId: "crypto-global",
    instrumentId: "BTCUSDT",
    binding: binding({
      sourcePolicyFingerprint: "d".repeat(64),
      bindingInstanceFingerprint: "e".repeat(64),
    }),
  });

  const diverged = await assertRoundBindingConsistency(pool, {
    strategyCode: "ai_conservative", symbol: "BTCUSDT", strategyVersionId: "version-a",
  });
  assert.equal(diverged.consistent, false);
  assert.deepEqual(diverged.fingerprints, ["a".repeat(64), "d".repeat(64)]);
  assert.equal(diverged.deploymentCount, 2);
});

test("绑定固定到策略版本：换版本不沿用旧绑定", async () => {
  // 同 DSL 换源必须重测，因此绑定的唯一键包含策略版本。
  const other = await loadMarketSourceBinding(pool, {
    deploymentId: "deployment-a", strategyVersionId: "version-b",
  });
  assert.equal(other, null, "另一个策略版本上不应存在绑定");
});
