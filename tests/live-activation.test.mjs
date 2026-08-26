import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_LIVE_PRINCIPAL_USDT,
  canActivateLive,
  checkLiveActivation,
} from "../packages/domain/src/execution/live-activation.ts";

// 「能不能给这个客户开实盘」的判定。每一条都对应一种把客户真钱置于风险中的具体方式，
// 而其中大多数不会报错，只会算错。

const ok = (over = {}) => ({
  account: {
    status: "active", environment: "live", exchange: "binance",
    canTrade: true, withdrawalAuthorized: false, verifiedAt: "2026-08-20T00:00:00Z",
    ...(over.account ?? {}),
  },
  declaredPrincipalUsdt: 3_000,
  observedBalanceUsdt: 3_000,
  membershipAllowsNewEntries: true,
  riskAcknowledged: true,
  liveRoutingGranted: true,
  hasActivePaperDeploymentOnCard: false,
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== "account")),
});

function codes(input) {
  return checkLiveActivation(input).map((blocker) => blocker.code);
}

test("全部满足时放行", () => {
  assert.deepEqual(checkLiveActivation(ok()), []);
  assert.equal(canActivateLive(ok()), true);
});

test("带提现权限的 API Key 一律拒绝——这条没有例外", () => {
  // INV-11。Key 泄露的损失不是交易亏损，是本金直接被转走。
  assert.ok(codes(ok({ account: { withdrawalAuthorized: true } })).includes("ACCOUNT_HAS_WITHDRAWAL_PERMISSION"));
});

test("模拟盘账户不能挂实盘部署", () => {
  // 客户会以为自己在真实交易，而订单全部落在模拟盘。
  assert.ok(codes(ok({ account: { environment: "demo" } })).includes("ACCOUNT_NOT_LIVE_ENVIRONMENT"));
});

test("凭证从未校验通过时拒绝", () => {
  // 第一次发现「这个 Key 不能下单」不该是在真实下单失败的时候。
  assert.ok(codes(ok({ account: { verifiedAt: null } })).includes("ACCOUNT_NOT_VERIFIED"));
});

test("没有交易权限或账户未激活时拒绝", () => {
  assert.ok(codes(ok({ account: { canTrade: false } })).includes("ACCOUNT_CANNOT_TRADE"));
  assert.ok(codes(ok({ account: { status: "pending" } })).includes("ACCOUNT_NOT_ACTIVE"));
});

test("申报本金不得超过账户实际余额", () => {
  // 百分比风控（单资产上限、回撤、日亏）全部以本金为分母。申报得比实际多，
  // 等于把所有风控上限按同一个比例放大，而没有任何一步会报错。
  assert.ok(codes(ok({ declaredPrincipalUsdt: 3_001, observedBalanceUsdt: 3_000 }))
    .includes("PRINCIPAL_EXCEEDS_BALANCE"));
  assert.deepEqual(checkLiveActivation(ok({ declaredPrincipalUsdt: 3_000, observedBalanceUsdt: 3_000 })), [],
    "刚好等于余额应该放行");
  assert.deepEqual(checkLiveActivation(ok({ declaredPrincipalUsdt: 1_000, observedBalanceUsdt: 3_000 })), [],
    "只投一部分资金是正常用法");
});

test("读不到余额时拒绝，而不是采信申报值", () => {
  // 放行意味着用一个无法核对的数字当作所有百分比风控的分母。
  assert.ok(codes(ok({ observedBalanceUsdt: null })).includes("BALANCE_UNAVAILABLE"));
});

test("本金低于下限时拒绝", () => {
  // 低于这个数，交易所的最小下单额会让大部分决策无法执行。
  assert.ok(codes(ok({ declaredPrincipalUsdt: MIN_LIVE_PRINCIPAL_USDT - 1, observedBalanceUsdt: 10_000 }))
    .includes("PRINCIPAL_BELOW_MINIMUM"));
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    assert.ok(codes(ok({ declaredPrincipalUsdt: bad })).includes("PRINCIPAL_BELOW_MINIMUM"), `${bad} 应被拒绝`);
  }
});

test("未授权的交易所在这里就说清楚，不等到每一轮下单失败", () => {
  assert.ok(codes(ok({ liveRoutingGranted: false })).includes("LIVE_ROUTING_NOT_GRANTED"));
});

test("同一张卡上还有模拟部署时拒绝", () => {
  // 两个部署会在同一批 K 线上各自产出决策，客户会看到同一张卡给出两套矛盾的叙述。
  assert.ok(codes(ok({ hasActivePaperDeploymentOnCard: true })).includes("PAPER_DEPLOYMENT_STILL_ACTIVE"));
});

test("会员失效或未确认风险时拒绝", () => {
  assert.ok(codes(ok({ membershipAllowsNewEntries: false })).includes("MEMBERSHIP_NOT_ACTIVE"));
  assert.ok(codes(ok({ riskAcknowledged: false })).includes("RISK_NOT_ACKNOWLEDGED"));
});

test("多个问题一次全部报出来，不是逐个挤牙膏", () => {
  // 一次只报一条会让客户改一次提交一次，来回七趟。
  const all = codes({
    account: { status: "pending", environment: "demo", exchange: "okx",
      canTrade: false, withdrawalAuthorized: true, verifiedAt: null },
    declaredPrincipalUsdt: 1, observedBalanceUsdt: null,
    membershipAllowsNewEntries: false, riskAcknowledged: false,
    liveRoutingGranted: false, hasActivePaperDeploymentOnCard: true,
  });
  assert.ok(all.length >= 9, `只报出了 ${all.length} 条：${all.join(",")}`);
});

test("每条阻塞都带可读说明", () => {
  for (const blocker of checkLiveActivation(ok({ account: { withdrawalAuthorized: true, canTrade: false } }))) {
    assert.ok(blocker.detail.length > 5, `${blocker.code} 缺少说明`);
  }
});
