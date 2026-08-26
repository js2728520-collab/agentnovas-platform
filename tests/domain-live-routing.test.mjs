import assert from "node:assert/strict";
import test from "node:test";

import { isRoutableProduct, resolveLiveRouting } from "../packages/domain/src/execution/live-routing.ts";

const OKX_LIVE = { exchange: "okx", environment: "live" };

test("永续在任何配置下都不可路由", () => {
  // 即使有人往授权表里塞一条永续记录，这里也必须挡住。
  // 配置错误不该等于风控失效。
  const decision = resolveLiveRouting({
    exchange: "okx", environment: "live", product: "usdt_perpetual",
    grants: [OKX_LIVE, { exchange: "okx", environment: "demo" }],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "PERPETUAL_ROUTING_FORBIDDEN");
  assert.equal(isRoutableProduct("usdt_perpetual"), false);
});

test("默认全关：没有授权就不放行", () => {
  const decision = resolveLiveRouting({
    exchange: "okx", environment: "live", product: "spot_usdt", grants: [],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "LIVE_ROUTING_NOT_GRANTED");
});

test("授权后的 OKX 现货实盘放行", () => {
  const decision = resolveLiveRouting({
    exchange: "okx", environment: "live", product: "spot_usdt", grants: [OKX_LIVE],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, null);
});

test("开通 demo 不等于开通实盘", () => {
  // 两个环境分别批准。混在一起会让一次「先在模拟盘试试」变成直接上实盘。
  const decision = resolveLiveRouting({
    exchange: "okx", environment: "live", product: "spot_usdt",
    grants: [{ exchange: "okx", environment: "demo" }],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "LIVE_ROUTING_NOT_GRANTED");
});

test("开通一家交易所不影响另一家", () => {
  const decision = resolveLiveRouting({
    exchange: "binance", environment: "live", product: "spot_usdt", grants: [OKX_LIVE],
  });
  assert.equal(decision.allowed, false);
});

test("交易所代号大小写与空格不敏感", () => {
  const decision = resolveLiveRouting({
    exchange: " OKX ", environment: "live", product: "spot_usdt",
    grants: [{ exchange: "okx", environment: "live" }],
  });
  assert.equal(decision.allowed, true);
});

test("交易所为空时拒绝，而不是匹配到空字符串授权", () => {
  const decision = resolveLiveRouting({
    exchange: "  ", environment: "live", product: "spot_usdt",
    grants: [{ exchange: "", environment: "live" }],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "EXCHANGE_UNKNOWN");
});
