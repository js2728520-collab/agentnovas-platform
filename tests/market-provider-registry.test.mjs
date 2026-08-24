import assert from "node:assert/strict";
import test from "node:test";

import {
  CRYPTO_MARKET_ID,
  defaultMarketVisibility,
  FOREX_MARKET_ID,
  isMarketVisible,
  marketAllowsExecution,
  METALS_MARKET_ID,
  registeredEquityProviders,
  registeredExchangeProviders,
  registeredMarkets,
} from "../packages/contracts/src/market-provider-registry.ts";
import { EXCHANGE_ROLLOUT_ORDER } from "../packages/contracts/src/product-parameters.ts";

test("八家交易所按 P-01 顺序登记，且默认未配置", () => {
  const providers = registeredExchangeProviders();
  assert.equal(providers.length, 8);
  assert.deepEqual(providers.map((entry) => entry.exchange), [...EXCHANGE_ROLLOUT_ORDER]);
  assert.deepEqual(providers.map((entry) => entry.rolloutPosition), [1, 2, 3, 4, 5, 6, 7, 8]);

  for (const provider of providers) {
    // 注册不等于已授权：凭证是部署事实，代码里写死 configured=true 等于宣称一个
    // 从未验证过的连接可用。
    assert.equal(provider.configured, false, `${provider.id} 默认必须未配置`);
    assert.equal(provider.connection, "disconnected");
    assert.equal(provider.health, "unknown");
    assert.deepEqual(provider.marketIds, [CRYPTO_MARKET_ID]);
  }
});

test("六个股票市场首期延迟 15 分钟，且不进入执行路径", () => {
  const providers = registeredEquityProviders();
  assert.equal(providers.length, 6);
  for (const provider of providers) {
    assert.equal(provider.mode, "delayed");
    assert.equal(provider.delayMinutes, 15);
    // 延迟源没有实时流；realtime_stream 要等实时授权后由配置升级加入。
    assert.ok(!provider.capabilities.includes("realtime_stream"), `${provider.id} 延迟源不应声明实时流`);
    assert.deepEqual(provider.protocols, ["rest"]);
    // 股票不进入执行路径（P-03）。
    assert.ok(!provider.usage.includes("execution"), `${provider.id} 不得声明 execution`);
    assert.equal(provider.configured, false);
  }
});

test("延迟源的 stale 阈值以自身延迟为基线，而不是套用实时秒级阈值", () => {
  const [delayed] = registeredEquityProviders("delayed");
  // 数据本来就晚 15 分钟。直接套用加密实时源的秒级阈值会让每条延迟行情都被判 stale，
  // stale Gate 就永远在响，等于没有 Gate。
  assert.equal(delayed.latencyTargetMs, 15 * 60_000);
  assert.ok(delayed.staleAfterMs > delayed.latencyTargetMs);
  assert.equal(delayed.staleAfterMs, 30 * 60_000);

  const [realtime] = registeredEquityProviders("realtime");
  assert.equal(realtime.latencyTargetMs, 500);
  assert.ok(realtime.staleAfterMs < delayed.staleAfterMs);
});

test("升级为实时也不等于可执行", () => {
  for (const provider of registeredEquityProviders("realtime")) {
    assert.ok(provider.capabilities.includes("realtime_stream"));
    // 实时只解锁数据能力，不解锁执行资格——两件事分开。
    assert.ok(!provider.usage.includes("execution"), `${provider.id} 升级实时后仍不得声明 execution`);
  }
});

test("只有加密市场可进入执行路径，且仍受 live Gate 约束", () => {
  assert.equal(marketAllowsExecution(CRYPTO_MARKET_ID), true);
  const crypto = registeredMarkets().find((market) => market.id === CRYPTO_MARKET_ID);
  // 可执行不等于已开放：执行策略仍是 live_gate_required。
  assert.equal(crypto.executionPolicy, "live_gate_required");

  for (const marketId of ["equities-us", "equities-cn", "equities-au", FOREX_MARKET_ID, METALS_MARKET_ID]) {
    assert.equal(marketAllowsExecution(marketId), false, `${marketId} 不得进入执行路径`);
  }
});

test("外汇与贵金属只读，不能由行情存在推导可交易", () => {
  const markets = registeredMarkets();
  for (const id of [FOREX_MARKET_ID, METALS_MARKET_ID]) {
    const market = markets.find((entry) => entry.id === id);
    assert.ok(market, `${id} 应已登记`);
    assert.equal(market.executionPolicy, "display_only");
    assert.ok(!market.usage.includes("execution"));
  }
});

test("市场可见性失败关闭：未登记的市场一律不可见", () => {
  const visibility = defaultMarketVisibility();
  assert.equal(isMarketVisible(CRYPTO_MARKET_ID, visibility), true);
  assert.equal(isMarketVisible("equities-au", visibility), true);

  // 运维端关掉某个市场后立即不可见。
  assert.equal(isMarketVisible("equities-kr", { ...visibility, "equities-kr": false }), false);

  // 拼错或未登记的 ID 不能「默认可见」——那会把不该露出的市场放出去。
  assert.equal(isMarketVisible("equities-xx", visibility), false);
  assert.equal(isMarketVisible("equities-us", {}), false);
  assert.equal(isMarketVisible("", visibility), false);
});

test("市场清单覆盖加密、六个股票市场与外汇贵金属", () => {
  const ids = registeredMarkets().map((market) => market.id).sort();
  assert.deepEqual(ids, [
    CRYPTO_MARKET_ID,
    "equities-au", "equities-cn", "equities-hk", "equities-jp", "equities-kr", "equities-us",
    FOREX_MARKET_ID, METALS_MARKET_ID,
  ].sort());

  // 每个股票市场都要有交易所日历与本地时区——按 UTC 连续交易处理会算错开收盘。
  for (const market of registeredMarkets().filter((entry) => entry.assetClass === "equity")) {
    assert.equal(market.calendar.kind, "exchange_managed");
    assert.notEqual(market.timezone, "UTC", `${market.id} 必须使用交易所本地时区`);
  }
  const crypto = registeredMarkets().find((market) => market.id === CRYPTO_MARKET_ID);
  assert.equal(crypto.calendar.kind, "continuous");
});
