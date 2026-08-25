import assert from "node:assert/strict";
import test from "node:test";

import { INTEGRATION_CATALOG } from "../lib/integration-catalog.ts";
import {
  isMarketProviderConfigured,
  marketProviderStatuses,
} from "../lib/market-provider-status.ts";
import {
  registeredEquityProviders,
  registeredExchangeProviders,
} from "../packages/contracts/src/market-provider-registry.ts";

const registryIds = [
  ...registeredExchangeProviders().map((entry) => entry.id),
  ...registeredEquityProviders().map((entry) => entry.id),
];

test("注册表里的每个 provider 都有配置入口", () => {
  // 没有配置入口的 provider 永远配不好，而界面上它看起来只是「未配置」——分不清是
  // 还没配还是根本没法配。
  const catalogIds = new Set(INTEGRATION_CATALOG.map((item) => item.id));
  for (const id of registryIds) {
    assert.ok(catalogIds.has(id), `${id} 在注册表里但没有配置入口`);
  }
  assert.equal(registryIds.length, 14, "P-01 八家交易所 + P-03 六个股票市场");
});

test("配置入口的每一项都要说清需要哪些环境变量", () => {
  for (const id of registryIds) {
    const definition = INTEGRATION_CATALOG.find((item) => item.id === id);
    assert.ok(definition.envKeys.length > 0, `${id} 没有说明需要配什么`);
    assert.equal(definition.requiresKey, true);
    // 凭证只在服务端。浏览器永远不该拿到它们（INV-9）。
    assert.equal(definition.serverOnly, true);
    // 未接通的 provider 不得标成 wired——那会让「未配置」看起来像「就绪」（INV-6）。
    assert.equal(definition.status, "ready-to-configure", `${id} 不应声称已接通`);
  }
});

test("默认环境下全部未配置，且说得出缺什么", () => {
  // 这是当前的真实状态：没有任何 provider 被真正接通过。
  const statuses = marketProviderStatuses({});
  assert.equal(statuses.length, 14);
  for (const status of statuses) {
    assert.equal(status.configured, false);
    assert.deepEqual([...status.missingEnvKeys], [...status.envKeys],
      `${status.providerId} 应当报告全部缺失`);
  }
});

test("凭证齐全才算配好——缺一个就是没配好，不是配了一半", () => {
  const binance = INTEGRATION_CATALOG.find((item) => item.id === "exchange-binance");
  assert.equal(binance.envKeys.length, 2, "交易所需要 key 与 secret");

  const partial = marketProviderStatuses({ [binance.envKeys[0]]: "只配了一半" })
    .find((entry) => entry.providerId === "exchange-binance");
  assert.equal(partial.configured, false);
  assert.deepEqual([...partial.missingEnvKeys], [binance.envKeys[1]]);

  const full = Object.fromEntries(binance.envKeys.map((key) => [key, "值"]));
  const complete = marketProviderStatuses(full).find((entry) => entry.providerId === "exchange-binance");
  assert.equal(complete.configured, true);
  assert.deepEqual([...complete.missingEnvKeys], []);
  assert.equal(isMarketProviderConfigured("exchange-binance", full), true);
});

test("空白值不算配置", () => {
  // 一个空字符串或全是空格的环境变量，比没设更危险——它看起来配过了。
  const binance = INTEGRATION_CATALOG.find((item) => item.id === "exchange-binance");
  const blank = Object.fromEntries(binance.envKeys.map((key) => [key, "   "]));
  assert.equal(isMarketProviderConfigured("exchange-binance", blank), false);
});

test("未登记的 provider 一律未配置", () => {
  assert.equal(isMarketProviderConfigured("exchange-nonexistent", {}), false);
  // 即便有人在环境里设了同名的 key。
  assert.equal(isMarketProviderConfigured("exchange-nonexistent", { ANYTHING: "值" }), false);
});

test("注册表自己仍恒报未配置——配置状态不由它回答", () => {
  // 注册表是合同，不是部署事实。把 configured 写死成 true 等于宣称一个从未验证过的连接
  // 可用；运行时消费者应当读 isMarketProviderConfigured，而不是注册表的那个字段。
  for (const provider of [...registeredExchangeProviders(), ...registeredEquityProviders()]) {
    assert.equal(provider.configured, false);
  }
});
