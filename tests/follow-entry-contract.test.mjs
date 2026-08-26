import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/strategy-marketplace/[id]/follow/route.client.ts", import.meta.url), "utf8");

test("开的是 paper 跟单，实盘仍然关闭", async () => {
  // 实盘跟单需要客户的交易所账户与执行服务；这条路径不碰任何交易所账户。
  assert.match(route, /run_mode='paper'|'paper'/);
  assert.match(route, /mode: "paper"/);
  assert.doesNotMatch(route, /exchange_account_id/);
  assert.doesNotMatch(route, /'live'/);
});

test("跟单输入失败关闭，不接受额外固定止盈", async () => {
  // 忽略 takeProfitPct 会让客户以为固定止盈已经生效；未知字段必须在写入前明确拒绝。
  assert.match(route, /allowedFields = new Set\(\["capitalPct", "stopLossPct", "acceptDisclosure"\]\)/);
  assert.match(route, /FOLLOW_INPUT_UNKNOWN_FIELDS/);
  assert.match(route, /unknownFields\.length > 0/);
  assert.doesNotMatch(route, /allowedFields[^;]*takeProfitPct/s);
});

test("披露必须被显式确认", async () => {
  // 默认同意等于没有确认。
  assert.match(route, /body\.acceptDisclosure !== true/);
  assert.match(route, /FOLLOW_DISCLOSURE_REQUIRED/);
  // 确认的是哪一版披露要能回溯——合同里存摘要，响应里回给客户。
  assert.match(route, /disclosureSha256: contract\.disclosureSha256/);
});

test("落在 user_confirmed 而不是 active", async () => {
  // 「已确认」与「已在跑」是两件事：首个决策周期才把它转成 active。
  assert.match(route, /'user_confirmed'/);
  assert.doesNotMatch(route, /status='active'.*strategy_subscriptions/s);
});

test("只有已上架的策略可跟随，且不能跟随自己", async () => {
  assert.match(route, /isPubliclyVisibleListingState/);
  assert.match(route, /STRATEGY_NOT_LISTED/);
  // 作者跟随自己的策略会让分账变成左手倒右手，且绕过「自用策略不产生平台收入」的判定。
  assert.match(route, /FOLLOW_SELF_NOT_ALLOWED/);
});

test("现货准入在入口就判，不留到运行时", async () => {
  // 留到运行时意味着客户已经确认了一个永远不会开仓的跟随。
  assert.match(route, /evaluateFollowSpotAdmission/);
  assert.match(route, /FOLLOW_NOT_ADMITTED_ON_SPOT/);
  assert.match(route, /现货模拟盘只支持只做多的策略/);
});

test("确认时固定合同，参数来自客户本次输入", async () => {
  assert.match(route, /pinFollowContract\(client, \{/);
  assert.match(route, /risk: \{ capitalPct, stopLossPct \}/);
  // 费率取客户会员档位（需求方确认），不是写死的 20%。
  assert.match(route, /resolveCustomerFollowFeeBps\(client, me\.id\)/);
});

test("重复点击返回原订阅，不报错也不重复建", async () => {
  assert.match(route, /replayed: true/);
  assert.match(route, /ON CONFLICT \(subscription_id\) DO NOTHING/);
  assert.match(route, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
});

test("整条路径在一个事务里", async () => {
  // 订阅、组合、合同、部署四张表要么一起成立要么一起不成立。建了订阅没建合同，
  // 下一轮 Runtime 会因为「跟单合同缺失」永远不跑。
  assert.match(route, /await client\.query\("BEGIN"\)/);
  assert.match(route, /await client\.query\("COMMIT"\)/);
  assert.match(route, /await client\.query\("ROLLBACK"\)/);
});
