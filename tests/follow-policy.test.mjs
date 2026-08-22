import assert from "node:assert/strict";
import test from "node:test";

import { evaluateFollowPolicy } from "../lib/follow-policy.ts";

// 跟单准入策略。
//
// 平台永不持有客户交易所账户的提现权限。此前的设计相反——要求客户开通提现授权
// 才能跟单，以便自动扣绩效分成。提现权限是交易所 API 密钥的最高权限，为 N 个客户
// 保管这样的密钥意味着执行主机一旦失陷，全部客户资金可被直接转出。
//
// 现在分成从客户预充的服务余额扣除，走优盾充值 + ledger + 应收 + maker/checker
// 复核路径，因此 manualCollectionRequired 恒为 true：平台不具备自动划扣能力。

test("带提现权限的账户一律拒绝跟单", () => {
  assert.deepEqual(evaluateFollowPolicy({
    withdrawalAuthorized: true,
    canTrade: true,
  }), {
    allowed: false,
    manualCollectionRequired: true,
    reason: "withdrawal_authority_forbidden",
  });
});

test("自用策略也不能豁免提现权限禁令", () => {
  // 任何豁免路径都不能成为「平台持有提现密钥」的合法入口，
  // 所以提现判断必须先于自用判断。
  assert.deepEqual(evaluateFollowPolicy({
    withdrawalAuthorized: true,
    canTrade: true,
    publicationMode: "self_use",
    strategyAuthorId: "customer-1",
    customerId: "customer-1",
  }), {
    allowed: false,
    manualCollectionRequired: true,
    reason: "withdrawal_authority_forbidden",
  });
});

test("只读 + 交易权限的账户允许跟单，分成走预充余额", () => {
  assert.deepEqual(evaluateFollowPolicy({
    withdrawalAuthorized: false,
    canTrade: true,
  }), {
    allowed: true,
    manualCollectionRequired: true,
    reason: "prepaid_balance_collection",
  });
});

test("没有下单权限的账户不能跟单", () => {
  assert.deepEqual(evaluateFollowPolicy({
    withdrawalAuthorized: false,
    canTrade: false,
  }), {
    allowed: false,
    manualCollectionRequired: true,
    reason: "trade_permission_required",
  });
});

test("作者自用策略跑在自己账户上", () => {
  assert.deepEqual(evaluateFollowPolicy({
    withdrawalAuthorized: false,
    canTrade: true,
    publicationMode: "self_use",
    strategyAuthorId: "customer-1",
    customerId: "customer-1",
  }), {
    allowed: true,
    manualCollectionRequired: true,
    reason: "private_self_use",
  });
});

test("他人的自用策略不走自用豁免", () => {
  const decision = evaluateFollowPolicy({
    withdrawalAuthorized: false,
    canTrade: true,
    publicationMode: "self_use",
    strategyAuthorId: "customer-1",
    customerId: "customer-2",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "prepaid_balance_collection");
});

test("分成永远不具备自动划扣能力", () => {
  // 任何一条通过路径都必须标记为人工收款：平台没有提现权限，
  // 也就没有从交易所账户直接划走分成的技术可能。
  for (const input of [
    { withdrawalAuthorized: false, canTrade: true },
    { withdrawalAuthorized: false, canTrade: true, publicationMode: "self_use", strategyAuthorId: "a", customerId: "a" },
  ]) {
    assert.equal(evaluateFollowPolicy(input).manualCollectionRequired, true);
  }
});
