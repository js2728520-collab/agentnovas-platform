import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import pg from "pg";

import { collectPlatformReadiness } from "../lib/platform-readiness.ts";
import { agentRoles, runtimeExplanationRoles } from "../lib/agent-model-profiles.ts";

// 开服就绪清单。它要回答的是「还差什么」——一个此前没有答案、只能靠人翻手册的问题。
//
// 这些检查上线后不会失效：某天有人把披露下架，或某个 Agent 角色的模型被停用，
// 清单会立刻变红。所以断言的重点是「缺了能发现」，而不是「配好了能通过」。

const databaseUrl = process.env.TEST_DATABASE_URL || "postgresql://127.0.0.1/postgres";
const schema = `readiness_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });

before(async () => {
  assert.match(schema, /^[a-z0-9_]+$/);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`
    CREATE TABLE users (id text PRIMARY KEY, role text NOT NULL, status text NOT NULL);
    CREATE TABLE organizations (id text PRIMARY KEY, type text NOT NULL, status text NOT NULL);
    CREATE TABLE commercial_legal_document_versions (id text PRIMARY KEY, document_type text NOT NULL, status text NOT NULL);
    CREATE TABLE commercial_plan_versions (id text PRIMARY KEY, price_currency text NOT NULL, status text NOT NULL);
    CREATE TABLE agent_role_bindings (role text PRIMARY KEY, enabled boolean NOT NULL);
    CREATE TABLE runtime_explanation_bindings (role text PRIMARY KEY, enabled boolean NOT NULL);
    CREATE TABLE payment_provider_configs (provider text PRIMARY KEY, status text NOT NULL);
  `);
});

after(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await Promise.all([pool.end(), admin.end()]);
});

function find(result, key) {
  const check = result.checks.find((item) => item.key === key);
  assert.ok(check, `缺少检查项 ${key}`);
  return check;
}

test("全空时每个阻塞项都报缺失，并给出该做什么", async () => {
  const result = await collectPlatformReadiness(pool);
  for (const key of ["administrator", "legal_disclosures", "membership_plans", "model_bindings"]) {
    const check = find(result, key);
    assert.notEqual(check.status, "ready", `${key} 不该是 ready`);
    assert.equal(check.severity, "blocking");
    // 「请配置 X」不是可执行的动作。每一项都要说清具体去哪、做什么。
    assert.ok(check.action && check.action.length > 15, `${key} 的动作说明太空泛`);
  }
  assert.ok(result.blockingCount >= 4);
});

test("披露按类型去重计数，同一类型的多个版本只算一次", async () => {
  await pool.query(`INSERT INTO commercial_legal_document_versions VALUES
    ('a','terms','published'), ('b','terms','published'), ('c','privacy','published')`);
  const check = find(await collectPlatformReadiness(pool), "legal_disclosures");
  assert.equal(check.detail, "已发布 2/7", "同一类型的两个版本只能算一项");
  assert.equal(check.status, "partial");
});

test("草稿不算已发布", async () => {
  await pool.query("INSERT INTO commercial_legal_document_versions VALUES ('d','risk_disclosure','draft')");
  const check = find(await collectPlatformReadiness(pool), "legal_disclosures");
  assert.equal(check.detail, "已发布 2/7", "草稿与待审批的不对外，也不该计入就绪");
});

test("会员计划币种与充值不一致时判为未就绪", async () => {
  // 客户充进来的是 USDT。计划按别的币种计价时，wallet_balances 按币种分行，
  // 那笔余额根本付不了会员——而这不会报错，只会「余额不足」。
  await pool.query("INSERT INTO commercial_plan_versions VALUES ('p1','USD','active')");
  const check = find(await collectPlatformReadiness(pool), "membership_plans");
  assert.equal(check.status, "missing");
  assert.match(check.detail, /USD/);
  assert.match(check.detail, /无法支付/);
});

test("币种正确时才就绪", async () => {
  await pool.query("UPDATE commercial_plan_versions SET price_currency='USDT'");
  const check = find(await collectPlatformReadiness(pool), "membership_plans");
  assert.equal(check.status, "ready");
  assert.match(check.detail, /USDT/);
});

test("模型绑定统计覆盖两类角色，缺一个就不算齐", async () => {
  for (const role of agentRoles) {
    await pool.query("INSERT INTO agent_role_bindings VALUES ($1, true)", [role]);
  }
  const partial = find(await collectPlatformReadiness(pool), "model_bindings");
  assert.equal(partial.status, "partial", "只绑了研发角色，运行时解释角色还缺");
  assert.match(partial.detail, new RegExp(`${agentRoles.length}/${agentRoles.length + runtimeExplanationRoles.length}`));

  for (const role of runtimeExplanationRoles) {
    await pool.query("INSERT INTO runtime_explanation_bindings VALUES ($1, true)", [role]);
  }
  assert.equal(find(await collectPlatformReadiness(pool), "model_bindings").status, "ready");
});

test("停用的绑定不计入——上线后被停用要能发现", async () => {
  await pool.query("UPDATE agent_role_bindings SET enabled=false WHERE role=$1", [agentRoles[0]]);
  const check = find(await collectPlatformReadiness(pool), "model_bindings");
  assert.equal(check.status, "partial", "停用一个角色后清单必须变红");
});

test("充值通道的动作说明必须提到 nginx 回调耦合", async () => {
  // provider 切 active 之后客户就能拿到真实链上地址并打款，而回调仍撞在边缘的 404 上
  // ——钱到账，账本上什么都没有。这条耦合不写在动作里，运维不会知道。
  const check = find(await collectPlatformReadiness(pool), "deposit_provider");
  assert.equal(check.status, "missing");
  assert.match(check.action, /nginx/);
  assert.match(check.action, /同一次变更/);
});

test("只有总公司时是警告而非阻塞", async () => {
  // 没有分公司不影响客户使用，只是分公司维度的统计是空的。
  await pool.query("INSERT INTO organizations VALUES ('hq','headquarters','active')");
  const check = find(await collectPlatformReadiness(pool), "organizations");
  assert.equal(check.severity, "warning");
  assert.equal(check.status, "partial");
});
