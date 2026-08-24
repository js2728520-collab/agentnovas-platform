import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isOfficialCardStrategyCode,
  OFFICIAL_CARD_PROVIDER_ID,
  OFFICIAL_CARD_STRATEGY_CODES,
  officialCardSourceSelection,
  registeredEquityProviders,
  registeredExchangeProviders,
} from "../packages/contracts/src/market-provider-registry.ts";
import { resolveMarketSourceBinding } from "../packages/contracts/src/market-source-binding.ts";
import {
  capabilitySnapshotFromRegistry,
  platformDefaultSelection,
  selectionForDeployment,
} from "../lib/market-source-resolution.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const cryptoPreference = {
  marketId: "crypto-global",
  selection: { mode: "independent", providerId: "exchange-okx" },
  updatedAt: "2026-08-24T00:00:00.000Z",
};

test("官方卡忽略客户偏好，恒用平台指定源（ADR-0025）", () => {
  for (const strategyCode of OFFICIAL_CARD_STRATEGY_CODES) {
    const resolved = selectionForDeployment({
      platformStrategyCode: strategyCode,
      marketId: "crypto-global",
      preference: cryptoPreference,
    });
    // 客户明确选了 okx，官方卡依然走平台指定源。这不是忽略了偏好，是 ADR-0018 的必然
    // 结果：同一张卡在同一根 K 线上只判断一次，按客户换源会产生多份矛盾的公开叙述。
    assert.deepEqual(resolved.selection, { mode: "independent", providerId: OFFICIAL_CARD_PROVIDER_ID });
    assert.equal(resolved.origin, "official_card_platform_source");
  }
  assert.notEqual(OFFICIAL_CARD_PROVIDER_ID, cryptoPreference.selection.providerId, "夹具必须用与平台源不同的 provider，否则这条断言恒真");
});

test("自定义策略用客户偏好；没选过时是默认值而不是一次选择", () => {
  const chosen = selectionForDeployment({
    platformStrategyCode: null, marketId: "crypto-global", preference: cryptoPreference,
  });
  assert.deepEqual(chosen.selection, { mode: "independent", providerId: "exchange-okx" });
  assert.equal(chosen.origin, "customer_preference");

  const untouched = selectionForDeployment({
    platformStrategyCode: null, marketId: "crypto-global", preference: null,
  });
  assert.equal(untouched.origin, "platform_default");
  assert.equal(untouched.selection.mode, "independent");

  // 另一个市场的偏好不会串过来。
  const other = selectionForDeployment({
    platformStrategyCode: null, marketId: "equities-us", preference: cryptoPreference,
  });
  assert.equal(other.origin, "platform_default");
  assert.equal(other.selection.providerId, "equity-us");

  assert.equal(selectionForDeployment({
    platformStrategyCode: null, marketId: "equities-xx", preference: null,
  }), null, "未登记的市场不得凭空得到一个源");
  assert.equal(platformDefaultSelection("equities-xx"), null);
});

test("官方卡代码与共享决策轮的 CHECK 约束一致", async () => {
  // 应用侧枚举与数据库允许值错开，会让「共享轮只属于官方卡」这条边界在其中一侧失效。
  const migration = await read("postgres/migrations/0046_shared_decision_rounds.sql");
  const constraint = migration.match(/strategy_code text NOT NULL CHECK \(strategy_code IN \(([^)]*)\)\)/);
  assert.ok(constraint, "未能在 0046 里找到 strategy_code 约束");
  const allowed = [...constraint[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(allowed, [...OFFICIAL_CARD_STRATEGY_CODES].sort());

  assert.equal(isOfficialCardStrategyCode("ai_balanced"), true);
  assert.equal(isOfficialCardStrategyCode("ai_ultra"), false);
  assert.equal(isOfficialCardStrategyCode(null), false);
  assert.deepEqual(officialCardSourceSelection(), { mode: "independent", providerId: OFFICIAL_CARD_PROVIDER_ID });
});

test("能力快照如实报告未配置，解析因此失败关闭", async () => {
  const snapshot = capabilitySnapshotFromRegistry({
    providerId: OFFICIAL_CARD_PROVIDER_ID,
    marketId: "crypto-global",
    instrumentId: "btcusdt",
    providerSymbol: "BTCUSDT",
  });
  // 还没有任何 provider 被真正接通过。伪装成已配置会让「未配置」看起来像「就绪」。
  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.capabilityVersionId, `market-registry-v1-${OFFICIAL_CARD_PROVIDER_ID}`);
  assert.equal(snapshot.sourceAccountId, null);

  const resolution = await resolveMarketSourceBinding({
    requesterUserId: "customer-a",
    strategyVersionId: "version-a",
    marketId: "crypto-global",
    instrumentId: "btcusdt",
    requestedUsage: "research",
    selection: officialCardSourceSelection(),
    account: null,
    source: snapshot,
  });
  assert.equal(resolution.status, "blocked");
  assert.equal(resolution.reason, "source_not_configured");
  assert.equal(resolution.binding, null);

  // 注册表里所有 provider 现在都未配置——这条断言会在第一个源真正接通时提醒更新本测试。
  const providers = [...registeredExchangeProviders(), ...registeredEquityProviders()];
  assert.ok(providers.length > 0);
  assert.deepEqual(providers.filter((provider) => provider.configured), []);
});

test("provider 与市场不匹配时返回 null，而不是编一个快照", () => {
  assert.equal(capabilitySnapshotFromRegistry({
    providerId: "exchange-binance", marketId: "equities-us",
    instrumentId: "aapl", providerSymbol: "AAPL",
  }), null);
  assert.equal(capabilitySnapshotFromRegistry({
    providerId: "exchange-nonexistent", marketId: "crypto-global",
    instrumentId: "btcusdt", providerSymbol: "BTCUSDT",
  }), null);
});
