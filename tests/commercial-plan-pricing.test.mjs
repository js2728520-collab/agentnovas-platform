import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { commercialBetaPlans } from "../packages/contracts/src/commercial-beta.ts";
import { MEMBERSHIP_PLANS } from "../packages/contracts/src/product-parameters.ts";

test("套餐定价三份副本以 P-07 为准，必须一致", async () => {
  // 由来：commercial-beta.ts 与需求方冻结的 P-07 长期互相矛盾（月卡 28 vs 59、年卡费率
  // 0.20 vs 0.18），而 CLAUDE.md 把前者写成「唯一真源」。需求方 2026-08-24 裁定以 P-07
  // 为准。三份对不上时，客户在落地页看到的价格、下单时快照的费率、以及 AI 助手复述的
  // 套餐信息会各说一套。
  const byCode = new Map(MEMBERSHIP_PLANS.map((plan) => [plan.code, plan]));
  assert.equal(commercialBetaPlans.length, MEMBERSHIP_PLANS.length);

  for (const plan of commercialBetaPlans) {
    const frozen = byCode.get(plan.code);
    assert.ok(frozen, `${plan.code} 不在已冻结的 P-07 里`);
    assert.equal(Number(plan.priceUsd), Number(frozen.priceUsdt), `${plan.code} 价格与 P-07 不一致`);
    assert.equal(plan.performanceFeeRate, frozen.performanceFeeRate, `${plan.code} 费率与 P-07 不一致`);
    assert.equal(plan.durationDays, frozen.durationDays, `${plan.code} 时长与 P-07 不一致`);
    assert.equal(plan.aiCredits, frozen.credits, `${plan.code} 积分与 P-07 不一致`);
  }
});

test("数据库里当前 active 的套餐版本与 P-07 一致", async () => {
  // 运行时费率来自下单时的快照，而快照取自 active 的 plan version。常量对了但库里没改，
  // 客户看到 59 却按 28 的费率下单。
  const directory = new URL("../postgres/migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const active = new Map();
  const retired = new Set();
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), "utf8");
    for (const match of sql.matchAll(/\('membership_[a-z0-9_]+','([a-z0-9_]+)',(\d+),(\d+),(?:NULL|\d+),(\d+),(\d+)(?:,'active')?/g)) {
      active.set(`${match[1]}:${match[2]}`, {
        code: match[1], version: Number(match[2]), price: Number(match[3]),
        credits: Number(match[4]), bps: Number(match[5]),
      });
    }
    for (const match of sql.matchAll(/SET status = 'retired'[\s\S]*?version = (\d+)/g)) {
      retired.add(Number(match[1]));
    }
  }
  assert.ok(retired.has(1), "旧版本必须被标 retired 而不是就地改——历史订单指向它们（INV-5）");

  for (const frozen of MEMBERSHIP_PLANS) {
    const seeded = active.get(`${frozen.code}:2`);
    assert.ok(seeded, `${frozen.code} 缺少 P-07 的 v2 版本`);
    assert.equal(seeded.price, Number(frozen.priceUsdt), `${frozen.code} 库中价格与 P-07 不一致`);
    assert.equal(seeded.bps, Math.round(Number(frozen.performanceFeeRate) * 10_000),
      `${frozen.code} 库中费率与 P-07 不一致`);
    assert.equal(seeded.credits, frozen.credits, `${frozen.code} 库中积分与 P-07 不一致`);
  }
});

test("旧版本的价格保留在迁移里，不被改写", async () => {
  // 历史订单通过 plan_version_id 指向 v1。就地改 v1 会静默改写所有历史订单当初的价格
  // 与费率，而没有任何地方会报错。
  const original = await readFile(
    new URL("../postgres/migrations/0023_commercial_membership_settlement.sql", import.meta.url), "utf8",
  );
  assert.match(original, /'membership_monthly_v1','monthly_v1',1,28,30,1000,2000/);
  assert.match(original, /'membership_lifetime_v1','lifetime_v1',1,588,NULL,36000,1600/);
});
