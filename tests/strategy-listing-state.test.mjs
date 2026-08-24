import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyStrategyListingTransition,
  isAuthorEditableListingState,
  isPubliclyVisibleListingState,
  isStrategyListingState,
  STRATEGY_LISTING_STATES,
} from "../packages/domain/src/strategy-listing-state.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("状态清单有四份副本，必须完全一致", async () => {
  // 状态机、数据库 CHECK、Drizzle enum、以及历史上散在路由里的字面量。前三份现在必须
  // 对齐——第四份已经收敛到状态机上。少一个状态，某条路径写入时炸成 23514 并被折叠成
  // INTERNAL_ERROR；多一个，库里会出现状态机不认识的值。
  const directory = new URL("../postgres/migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  let allowed = null;
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), "utf8");
    for (const match of sql.matchAll(/community_strategies_status_check CHECK \(status IN \(([^)]*)\)\)/g)) {
      allowed = [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]);
    }
  }
  assert.ok(allowed, "未能从迁移里解析出 community_strategies_status_check");
  assert.deepEqual([...STRATEGY_LISTING_STATES].sort(), [...allowed].sort());

  const schema = await read("db/schema.ts");
  // 只在 communityStrategies 这张表的定义里找。schema.ts 里有多个同形状的 status 列
  // （提现单也是 enum + default("draft")），不限定表会匹配到另一张表上。
  const tableStart = schema.indexOf('export const communityStrategies');
  assert.notEqual(tableStart, -1, "未能在 db/schema.ts 里找到 communityStrategies");
  const tableBlock = schema.slice(tableStart, schema.indexOf('});', tableStart));
  const enumMatch = tableBlock.match(/status: text\("status", \{ enum: \[([^\]]*)\] \}\)/);
  assert.ok(enumMatch, "未能在 communityStrategies 里找到 status 的取值");
  const drizzle = [...enumMatch[1].matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...drizzle].sort(), [...allowed].sort());
});

test("投稿走状态机，非法迁移给出当前状态可做什么", () => {
  assert.deepEqual(applyStrategyListingTransition("draft", "submit"), { allowed: true, nextState: "submitted" });
  assert.deepEqual(applyStrategyListingTransition("testing", "submit"), { allowed: true, nextState: "submitted" });
  assert.deepEqual(applyStrategyListingTransition("rejected", "submit"), { allowed: true, nextState: "submitted" });

  // 已提交的策略不能再次提交：审核对象会在审核期间变化。
  const twice = applyStrategyListingTransition("submitted", "submit");
  assert.equal(twice.allowed, false);
  assert.equal(twice.reason, "transition_not_allowed");
  // 报出当前状态能做什么，而不只是「不行」。
  assert.deepEqual(twice.allowedTransitions.sort(), ["claim_review", "reject"]);
});

test("审核必须先认领；未认领不能直接通过", () => {
  assert.equal(applyStrategyListingTransition("submitted", "approve").allowed, false);
  assert.deepEqual(applyStrategyListingTransition("submitted", "claim_review"), {
    allowed: true, nextState: "under_review",
  });
  assert.deepEqual(applyStrategyListingTransition("under_review", "approve"), {
    allowed: true, nextState: "approved",
  });
  // 驳回不需要先认领：一眼能判定的不合格件不该被迫先占用一个审核位。
  assert.deepEqual(applyStrategyListingTransition("submitted", "reject"), {
    allowed: true, nextState: "rejected",
  });
});

test("审核通过与上架是两个动作", () => {
  // PRD 6.5 的状态流里 APPROVED 与 LISTED 各自成态：通过审核不等于立刻对外可见。
  assert.deepEqual(applyStrategyListingTransition("approved", "list"), { allowed: true, nextState: "listed" });
  assert.equal(isPubliclyVisibleListingState("approved"), false);
  assert.equal(isPubliclyVisibleListingState("listed"), true);
  for (const state of STRATEGY_LISTING_STATES) {
    if (state !== "listed") assert.equal(isPubliclyVisibleListingState(state), false, `${state} 不应对客户可见`);
  }
});

test("delisted 是终态，不能原地复活", () => {
  // 允许 delisted → listed 会让「下架」变成可以被悄悄撤销的动作，而跟随者当初正是看着
  // 上架状态做的决定。重新上架必须走新版本重新审核。
  assert.equal(applyStrategyListingTransition("delisted", "list").allowed, false);
  assert.equal(applyStrategyListingTransition("delisted", "approve").allowed, false);
  assert.deepEqual(applyStrategyListingTransition("delisted", "revise"), { allowed: true, nextState: "draft" });
});

test("已提交之后作者不能再改内容", () => {
  assert.equal(isAuthorEditableListingState("draft"), true);
  assert.equal(isAuthorEditableListingState("testing"), true);
  assert.equal(isAuthorEditableListingState("rejected"), true);
  for (const state of ["submitted", "under_review", "approved", "listed", "delisted"]) {
    assert.equal(isAuthorEditableListingState(state), false, `${state} 期间不应允许作者改内容`);
  }
});

test("未知状态不猜，直接判为 unknown_state", () => {
  // 库里出现状态机不认识的值，说明有写入路径绕过了它。猜一个最接近的状态会把这个信号
  // 抹掉，而它正是「有地方在绕过状态机」的唯一证据。
  const result = applyStrategyListingTransition("published", "list");
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "unknown_state");
  assert.deepEqual(result.allowedTransitions, []);

  assert.equal(isStrategyListingState("paused"), false);
  assert.equal(isStrategyListingState("listed"), true);
  assert.equal(isStrategyListingState(null), false);
});

test("路由不再用字面量做状态判断", async () => {
  const submit = await read("app/api/strategy-marketplace/[id]/submit/route.client.ts");
  // 此前是 `["draft","testing","rejected"].includes(strategy.status)`——迁移规则散落在
  // 六个路由里，没有任何地方写明合法迁移的全集。
  assert.match(submit, /applyStrategyListingTransition\(strategy\.status, "submit"\)/);
  assert.doesNotMatch(submit, /\["draft", "testing", "rejected"\]\.includes/);

  const review = await read("app/api/operations/strategy-listing-reviews/[id]/decision/route.operations.ts");
  assert.match(review, /applyStrategyListingTransition\(strategy\.status, transition\)/);
});
