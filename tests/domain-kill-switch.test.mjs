import assert from "node:assert/strict";
import test from "node:test";

import { admitOrder, resolveKillSwitch } from "../packages/domain/src/execution/kill-switch.ts";

const CONTEXT = { exchange: "okx", accountId: "acct-1", strategyCode: "trend-v1" };
const CLEAN = { hasEscalated: false, pendingSymbols: [] };

function base(overrides = {}) {
  return {
    side: "buy", symbol: "BTC/USDT", context: CONTEXT,
    killSwitches: [], reconciliation: CLEAN, ...overrides,
  };
}

test("三个维度各自都能挡住开仓", () => {
  const cases = [
    [{ dimension: "exchange", scopeValue: "okx", reason: "撮合异常" }, "KILL_SWITCH_EXCHANGE"],
    [{ dimension: "account", scopeValue: "acct-1", reason: "客户申诉" }, "KILL_SWITCH_ACCOUNT"],
    [{ dimension: "strategy", scopeValue: "trend-v1", reason: "回撤异常" }, "KILL_SWITCH_STRATEGY"],
  ];
  for (const [entry, reason] of cases) {
    const admission = admitOrder(base({ killSwitches: [entry] }));
    assert.equal(admission.allowed, false);
    assert.equal(admission.reason, reason);
  }
});

test("不匹配的开关不影响其它对象", () => {
  const switches = [
    { dimension: "exchange", scopeValue: "binance", reason: "x" },
    { dimension: "account", scopeValue: "acct-9", reason: "x" },
    { dimension: "strategy", scopeValue: "mean-rev", reason: "x" },
  ];
  assert.equal(admitOrder(base({ killSwitches: switches })).allowed, true);
});

test("交易所代号大小写不敏感", () => {
  // 运营手输 OKX 与系统里的 okx 必须是同一件事，否则熔断看起来挂上了却不生效。
  const admission = admitOrder(base({
    killSwitches: [{ dimension: "exchange", scopeValue: "OKX", reason: "撮合异常" }],
  }));
  assert.equal(admission.allowed, false);
});

test("账户 id 必须精确匹配，不做模糊", () => {
  const admission = admitOrder(base({
    killSwitches: [{ dimension: "account", scopeValue: "acct-1 ", reason: "x" }],
  }));
  assert.equal(admission.allowed, true, "多一个空格就不是同一个账户");
});

test("没有策略卡来源时，策略维度的开关不匹配", () => {
  // 手动平仓这类没有卡来源的操作不应被某张卡的熔断误伤。
  const admission = admitOrder(base({
    context: { ...CONTEXT, strategyCode: null },
    killSwitches: [{ dimension: "strategy", scopeValue: "trend-v1", reason: "x" }],
  }));
  assert.equal(admission.allowed, true);
});

test("平仓永不被熔断挡住——三个维度全挂上也一样", () => {
  // 把平仓也挡住，等于客户在最需要离场的时候离不了，
  // 恰恰是熔断本该保护他免于遭遇的处境。
  const admission = admitOrder(base({
    side: "sell",
    killSwitches: [
      { dimension: "exchange", scopeValue: "okx", reason: "x" },
      { dimension: "account", scopeValue: "acct-1", reason: "x" },
      { dimension: "strategy", scopeValue: "trend-v1", reason: "x" },
    ],
    reconciliation: { hasEscalated: true, pendingSymbols: ["BTC/USDT"] },
  }));
  assert.equal(admission.allowed, true);
  assert.equal(admission.reason, null);
});

test("熔断优先于对账给出原因，两道闸门都在", () => {
  const blocked = admitOrder(base({
    killSwitches: [{ dimension: "exchange", scopeValue: "okx", reason: "x" }],
    reconciliation: { hasEscalated: true, pendingSymbols: [] },
  }));
  assert.equal(blocked.reason, "KILL_SWITCH_EXCHANGE");

  const reconciliationOnly = admitOrder(base({
    reconciliation: { hasEscalated: true, pendingSymbols: [] },
  }));
  assert.equal(reconciliationOnly.reason, "RECONCILIATION_ESCALATED");
});

test("resolveKillSwitch 回传命中的那一条，便于告诉运营是哪个开关", () => {
  const entry = { dimension: "account", scopeValue: "acct-1", reason: "客户申诉" };
  const result = resolveKillSwitch([entry], CONTEXT);
  assert.equal(result.blocked, true);
  assert.equal(result.matched.reason, "客户申诉");
});
