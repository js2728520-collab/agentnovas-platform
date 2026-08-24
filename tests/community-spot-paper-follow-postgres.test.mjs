import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { leaseNextStrategyDeployment } from "../lib/strategy-runtime-repository.ts";
import { runPostgresMigrations } from "../scripts/postgres-migration-runner.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `community_spot_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 3, options: `-c search_path=${schema}` });
let migrationDirectory;

const deploy = (id, columns, values) => pool.query(`
  INSERT INTO strategy_deployments(
    id,owner_user_id,strategy_id,strategy_version_id,mode,status,validation_label,
    idempotency_key,execution_product${columns}
  ) VALUES ($1,'spot-customer','spot-strategy','spot-version',$2,'active','UNVERIFIED',$1,'spot_usdt'${values})
`, [id, values.includes("SHADOW_MODE") ? "shadow" : "paper"]);

test.before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  migrationDirectory = await mkdtemp(join(tmpdir(), "agentnovas-spot-"));
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const source = new URL("../postgres/migrations/", import.meta.url);
  for (const name of await readdir(source)) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) continue;
    await writeFile(join(migrationDirectory, name), await readFile(new URL(name, source)));
  }
  await runPostgresMigrations(pool, {
    directory: new URL(`file://${migrationDirectory}/`),
    commitSha: "community-spot-test",
  });
  await pool.query(`
    INSERT INTO users(id,email,password_hash,role,status) VALUES
      ('spot-author','spot-author@quality.invalid','test-only-hash','customer','active'),
      ('spot-customer','spot-customer@quality.invalid','test-only-hash','customer','active');
    INSERT INTO community_strategies(id,author_user_id,name,status,version,validation_label)
      VALUES ('spot-strategy','spot-author','现货模拟策略','listed',1,'STANDARD_VERIFIED');
    INSERT INTO strategy_versions(id,strategy_id,version,specification_json,created_by_user_id)
      VALUES ('spot-version','spot-strategy',1,'{}','spot-author');
    INSERT INTO strategy_subscriptions(id,strategy_id,customer_id,status,started_at,strategy_version_id,run_mode)
      VALUES ('spot-subscription','spot-strategy','spot-customer','active','2026-08-01T00:00:00Z','spot-version','paper');
    INSERT INTO strategy_follow_paper_portfolios(id,subscription_id,customer_id,strategy_id)
      VALUES ('spot-portfolio','spot-subscription','spot-customer','spot-strategy');
  `);
});

test.after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
  await rm(migrationDirectory, { recursive: true, force: true });
});

test("社区策略现在可以有现货模拟部署", async () => {
  // 此前只能走 usdt_perpetual，而永续路由硬关闭——于是一笔成交都产生不了。
  await deploy("spot-deployment",
    ",strategy_subscription_id,follow_paper_portfolio_id",
    ",'spot-subscription','spot-portfolio'");
  const row = await pool.query(
    "SELECT execution_product,mode,platform_strategy_code FROM strategy_deployments WHERE id='spot-deployment'");
  assert.equal(row.rows[0].execution_product, "spot_usdt");
  assert.equal(row.rows[0].platform_strategy_code, null, "社区策略部署不得带官方卡代号");
});

test("实盘对社区策略仍然关闭", async () => {
  // 约束里写死，不靠代码自觉。
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_deployments(
        id,owner_user_id,strategy_id,strategy_version_id,mode,status,validation_label,
        idempotency_key,execution_product,strategy_subscription_id,follow_paper_portfolio_id
      ) VALUES ('spot-live','spot-customer','spot-strategy','spot-version','live','active','UNVERIFIED',
        'spot-live','spot_usdt','spot-subscription','spot-portfolio')
    `),
    (error) => /strategy_deployments_official_binding_check/.test(error.message),
  );
});

test("社区部署不得绑交易所账户，也不得混用官方卡组合", async () => {
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_deployments(
        id,owner_user_id,strategy_id,strategy_version_id,mode,status,validation_label,
        idempotency_key,execution_product,strategy_subscription_id,follow_paper_portfolio_id,platform_strategy_code
      ) VALUES ('spot-mixed','spot-customer','spot-strategy','spot-version','paper','active','UNVERIFIED',
        'spot-mixed','spot_usdt','spot-subscription','spot-portfolio','ai_conservative')
    `),
    (error) => /strategy_deployments_official_binding_check/.test(error.message),
    "一个部署要么是官方卡要么是社区跟随，不能两者都是",
  );
});

test("官方卡部署不受影响，仍然照旧", async () => {
  await pool.query(`
    INSERT INTO memberships(id,customer_id,plan_code,status) VALUES ('spot-membership','spot-customer','fixture','active');
    INSERT INTO official_paper_portfolios(id,membership_id,customer_id,strategy_code,risk_json)
      VALUES ('spot-official-portfolio','spot-membership','spot-customer','ai_conservative','{}');
    INSERT INTO strategy_deployments(
      id,owner_user_id,strategy_id,strategy_version_id,mode,status,validation_label,
      idempotency_key,execution_product,platform_strategy_code,membership_id,paper_portfolio_id
    ) VALUES ('spot-official','spot-customer','spot-strategy','spot-version','paper','active','UNVERIFIED',
      'spot-official','spot_usdt','ai_conservative','spot-membership','spot-official-portfolio');
  `);
  const row = await pool.query("SELECT platform_strategy_code FROM strategy_deployments WHERE id='spot-official'");
  assert.equal(row.rows[0].platform_strategy_code, "ai_conservative");
});

test("官方卡的 Runtime 路径不会租走社区部署——门开了但房间还没建好", async () => {
  // 这是本切片最重要的一条。放宽约束让社区现货部署可以存在，但
  // processOfficialSpotRuntimeDeployment 是为官方卡写的（读 platform_strategy_code、
  // 写 official_paper_portfolios）。租约的过滤挡住了它们——这是失败关闭，不是遗漏。
  // 等社区 Runtime 路径建好才应该放行。
  const leased = await leaseNextStrategyDeployment(pool, {
    workerId: "spot-worker", now: new Date(Date.now() + 60_000), leaseSeconds: 30,
  });
  // 不假设官方卡夹具一定满足全部租约前置条件（会员状态、周期时间等）；这里要守的是
  // **社区部署永远不被租走**，无论官方卡那边是什么结果。
  assert.notEqual(leased?.id, "spot-deployment", "社区部署不得被官方卡路径租走");

  // 直接验证那条过滤仍在。去掉它，上面的断言会因为夹具恰好不可租而继续为真——
  // 一条恒真的断言守不住任何东西。
  const repository = await readFile(
    new URL("../lib/strategy-runtime-repository.ts", import.meta.url), "utf8");
  const leaseSql = repository.slice(
    repository.indexOf("export async function leaseNextStrategyDeployment"),
    repository.indexOf("export async function leaseNextRuntimeExplanationJob"),
  );
  assert.match(leaseSql, /deployment\.platform_strategy_code IS NOT NULL/);
  assert.match(leaseSql, /deployment\.paper_portfolio_id IS NOT NULL/);
});

test("社区部署不得饿死官方部署", async () => {
  // 租约的挑选 CTE 每次只取一行。若 platform_strategy_code IS NOT NULL 只写在 UPDATE 上，
  // CTE 取到社区部署时 UPDATE 不匹配、整条语句返回空，排在后面的官方部署永远轮不到。
  // 这是 0087 允许社区现货部署存在之后才可能发生的——放宽约束时必须一并检查所有
  // 「先挑一行再筛」的查询。
  await pool.query(`
    UPDATE strategy_deployments SET next_cycle_at = now() - interval '1 hour', lease_expires_at = NULL
     WHERE id IN ('spot-deployment','spot-official')
  `);
  // 社区部署的 id 排在官方前面，且 next_cycle_at 相同——CTE 会先选中它。
  assert.ok("spot-deployment" < "spot-official", "夹具必须让社区部署排在前面，否则测不到饿死");

  const leased = await leaseNextStrategyDeployment(pool, {
    workerId: "starve-worker", now: new Date(), leaseSeconds: 30,
  });
  assert.equal(leased?.id, "spot-official", "官方部署必须仍能被租到");
});

test("一次订阅只有一个生效中的部署", async () => {
  // 没有它，同一个跟随可以被两个部署驱动，模拟组合上会记两倍仓位。
  await assert.rejects(
    pool.query(`
      INSERT INTO strategy_deployments(
        id,owner_user_id,strategy_id,strategy_version_id,mode,status,validation_label,
        idempotency_key,execution_product,strategy_subscription_id,follow_paper_portfolio_id
      ) VALUES ('spot-duplicate','spot-customer','spot-strategy','spot-version','paper','active','UNVERIFIED',
        'spot-duplicate','spot_usdt','spot-subscription','spot-portfolio')
    `),
    (error) => /uq_strategy_deployments_active_follow|duplicate key/.test(error.message),
  );
});
