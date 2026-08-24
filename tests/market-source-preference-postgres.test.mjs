import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { defaultMarketVisibility } from "../packages/contracts/src/market-provider-registry.ts";
import {
  assertSelectableMarketSource,
  listMarketSourcePreferences,
  loadMarketSourcePreference,
  saveMarketSourcePreference,
  selectableProvidersForMarket,
} from "../lib/market-source-preference-repository.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `market_source_pref_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
const visibility = defaultMarketVisibility();
let migrationDirectory;

async function rejectsWith(run, code, status) {
  await assert.rejects(run, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-preference-migrations-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "preference-test",
  });

  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('pref-owner','pref-owner@quality.invalid','test-only-hash','customer','active'),
      ('pref-other','pref-other@quality.invalid','test-only-hash','customer','active');
    INSERT INTO exchange_accounts(id,customer_id,exchange,label,encrypted_credential_ref,status,can_read,can_trade)
    VALUES
      ('account-readable','pref-owner','binance','读行情','ciphertext-placeholder','active',1,0),
      ('account-unreadable','pref-owner','okx','无读权限','ciphertext-placeholder','active',0,0),
      ('account-pending','pref-owner','kraken','待激活','ciphertext-placeholder','pending',1,0),
      ('account-of-other','pref-other','binance','别人的','ciphertext-placeholder','active',1,0);
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("偏好可变：改选覆盖旧值，每个 (客户, 市场) 只有一条", async () => {
  const first = await saveMarketSourcePreference(pool, {
    ownerUserId: "pref-owner", marketId: "crypto-global",
    selection: { mode: "independent", providerId: "exchange-okx" },
  });
  assert.deepEqual(first.selection, { mode: "independent", providerId: "exchange-okx" });

  // 改成账户对齐模式：provider_id 必须被清空，否则库里会同时留下两个「客户选的源」。
  const second = await saveMarketSourcePreference(pool, {
    ownerUserId: "pref-owner", marketId: "crypto-global",
    selection: { mode: "account_aligned", accountId: "account-readable" },
  });
  assert.deepEqual(second.selection, { mode: "account_aligned", accountId: "account-readable" });

  const stored = await pool.query(
    "SELECT account_id, provider_id FROM customer_market_source_preferences WHERE owner_user_id='pref-owner' AND market_id='crypto-global'",
  );
  assert.equal(stored.rowCount, 1, "同一市场不得留下第二条偏好");
  assert.equal(stored.rows[0].provider_id, null);
  assert.equal(stored.rows[0].account_id, "account-readable");
});

test("数据库拒绝模式与标识不匹配的偏好", async () => {
  const insert = (mode, accountId, providerId) => pool.query(
    `INSERT INTO customer_market_source_preferences (id, owner_user_id, market_id, selection_mode, account_id, provider_id)
     VALUES ($1,'pref-owner','equities-us',$2,$3,$4)`,
    [`broken-${mode}-${accountId ?? "none"}-${providerId ?? "none"}`, mode, accountId, providerId],
  );
  const violates = (error) => /customer_market_source_preferences_mode_target_check/.test(error.message);

  // 两个都填：解析只会读其中一个，另一个成为看不见的错误配置。
  await assert.rejects(insert("independent", "account-readable", "exchange-okx"), violates);
  await assert.rejects(insert("account_aligned", "account-readable", "exchange-okx"), violates);
  // 一个都不填：偏好存在但没有内容。
  await assert.rejects(insert("independent", null, null), violates);
  // 模式与标识写反。
  await assert.rejects(insert("independent", "account-readable", null), violates);
  await assert.rejects(insert("account_aligned", null, "exchange-okx"), violates);
});

test("改偏好不动既有绑定——这正是两张表分开的理由", async () => {
  await pool.query(`
    INSERT INTO community_strategies(id,author_user_id,name) VALUES ('pref-strategy','pref-owner','Fixture');
    INSERT INTO strategy_versions(id,strategy_id,version,specification_json,created_by_user_id)
      VALUES ('pref-version','pref-strategy',1,'{}','pref-owner');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode,runtime_status)
      VALUES ('pref-subscription','pref-strategy','pref-owner','active','2026-08-01T00:00:00Z','pref-version','paper','active');
    INSERT INTO memberships(id,customer_id,plan_code,status) VALUES ('pref-membership','pref-owner','fixture','active');
    INSERT INTO official_paper_portfolios(id,membership_id,customer_id,strategy_code,risk_json)
      VALUES ('pref-portfolio','pref-membership','pref-owner','ai_conservative','{}');
    -- spot 部署在库层就必须是官方卡（0053 的 official_binding_check），因此这里用官方卡做
    -- 夹具。本用例断言的是两张表互不影响，与策略种类无关。
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,strategy_subscription_id,exchange_account_id,
      mode,status,validation_label,idempotency_key,execution_product,
      platform_strategy_code,membership_id,paper_portfolio_id
    ) VALUES ('pref-deployment','pref-owner','pref-strategy','pref-version','pref-subscription',NULL,
      'paper','active','UNVERIFIED','pref-key','spot_usdt','ai_conservative','pref-membership','pref-portfolio');
    INSERT INTO strategy_market_source_bindings(
      id,deployment_id,owner_user_id,strategy_version_id,market_id,instrument_id,selection_mode,
      provider_id,provider_symbol,account_id,source_account_id,requested_usage,authorization_kind,
      capability_version_id,source_policy_fingerprint,binding_instance_fingerprint,pinning
    ) VALUES ('pref-binding','pref-deployment','pref-owner','pref-version','crypto-global','BTCUSDT',
      'independent','exchange-binance','BTCUSDT',NULL,NULL,'research','public',
      'capability-1',repeat('a',64),repeat('b',64),'pinned');
  `);

  await saveMarketSourcePreference(pool, {
    ownerUserId: "pref-owner", marketId: "crypto-global",
    selection: { mode: "independent", providerId: "exchange-kraken" },
  });

  const binding = await pool.query(
    "SELECT provider_id FROM strategy_market_source_bindings WHERE id='pref-binding'",
  );
  // 客户换了偏好，既有部署仍按当初解析出来的源运行。否则同一段历史决策会在事后被换成
  // 另一个数据源解释，回放与归因都不再成立。
  assert.equal(binding.rows[0].provider_id, "exchange-binance");

  const preference = await loadMarketSourcePreference(pool, {
    ownerUserId: "pref-owner", marketId: "crypto-global",
  });
  assert.deepEqual(preference.selection, { mode: "independent", providerId: "exchange-kraken" });
});

test("校验：市场必须已登记且可见", async () => {
  await rejectsWith(() => assertSelectableMarketSource(pool, {
    ownerUserId: "pref-owner", marketId: "equities-xx",
    selection: { mode: "independent", providerId: "exchange-okx" }, visibility,
  }), "MARKET_NOT_REGISTERED", 404);

  await rejectsWith(() => assertSelectableMarketSource(pool, {
    ownerUserId: "pref-owner", marketId: "equities-us",
    selection: { mode: "independent", providerId: "equity-us" },
    visibility: { ...visibility, "equities-us": false },
  }), "MARKET_NOT_VISIBLE", 404);
});

test("校验：provider 必须登记在该市场下", async () => {
  assert.ok(selectableProvidersForMarket("crypto-global").includes("exchange-okx"));
  assert.ok(!selectableProvidersForMarket("crypto-global").includes("equity-us"));

  // 股票源不能被选来取加密行情——否则错误要等到解析时才暴露。
  await rejectsWith(() => assertSelectableMarketSource(pool, {
    ownerUserId: "pref-owner", marketId: "crypto-global",
    selection: { mode: "independent", providerId: "equity-us" }, visibility,
  }), "MARKET_SOURCE_NOT_AVAILABLE", 422);
});

test("校验：账户必须属于本人且可读", async () => {
  await assertSelectableMarketSource(pool, {
    ownerUserId: "pref-owner", marketId: "crypto-global",
    selection: { mode: "account_aligned", accountId: "account-readable" }, visibility,
  });

  // 别人的账户与不存在的账户返回同一个 404：区分开会泄露「这个账户 ID 存在」。
  await rejectsWith(() => assertSelectableMarketSource(pool, {
    ownerUserId: "pref-owner", marketId: "crypto-global",
    selection: { mode: "account_aligned", accountId: "account-of-other" }, visibility,
  }), "EXCHANGE_ACCOUNT_NOT_FOUND", 404);
  await rejectsWith(() => assertSelectableMarketSource(pool, {
    ownerUserId: "pref-owner", marketId: "crypto-global",
    selection: { mode: "account_aligned", accountId: "account-missing" }, visibility,
  }), "EXCHANGE_ACCOUNT_NOT_FOUND", 404);

  for (const accountId of ["account-unreadable", "account-pending"]) {
    await rejectsWith(() => assertSelectableMarketSource(pool, {
      ownerUserId: "pref-owner", marketId: "crypto-global",
      selection: { mode: "account_aligned", accountId }, visibility,
    }), "EXCHANGE_ACCOUNT_UNAVAILABLE", 422);
  }
});

test("列表按客户隔离", async () => {
  await saveMarketSourcePreference(pool, {
    ownerUserId: "pref-other", marketId: "equities-us",
    selection: { mode: "independent", providerId: "equity-us" },
  });
  const mine = await listMarketSourcePreferences(pool, "pref-owner");
  const theirs = await listMarketSourcePreferences(pool, "pref-other");
  assert.ok(mine.every((preference) => preference.marketId !== "equities-us"));
  assert.deepEqual(theirs.map((preference) => preference.marketId), ["equities-us"]);
});
