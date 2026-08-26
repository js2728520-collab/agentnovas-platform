import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isMarketVisibilityFamily,
  MARKET_VISIBILITY_FAMILY,
  normalizeMarketVisibilityPayload,
  resolveMarketVisibility,
  runMarketVisibilityTest,
} from "../lib/market-visibility-configuration.ts";
import {
  normalizeConfigurationFamilyPayload,
  runRegisteredConfigurationFamilyTest,
} from "../lib/configuration-family-registry.ts";
import { CRYPTO_MARKET_ID } from "../packages/contracts/src/market-provider-registry.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const family = (payload) => ({ ...MARKET_VISIBILITY_FAMILY, payload });

function rejects(run, fields) {
  assert.throws(run, (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, "CONFIGURATION_FAMILY_SCHEMA_INVALID");
    if (fields) assert.deepEqual(error.details?.fields, fields);
    return true;
  });
}

test("payload 只允许注册表里已有的市场 ID", () => {
  const normalized = normalizeMarketVisibilityPayload({
    markets: { "equities-au": false, "equities-kr": true },
  });
  assert.deepEqual(normalized, { markets: { "equities-au": false, "equities-kr": true } });

  // 拼错的 ID 必须拒绝而不是忽略：静默忽略会让运维以为自己关掉了某个市场，
  // 实际那条配置从未生效——「以为关了其实开着」比报错危险得多。
  rejects(() => normalizeMarketVisibilityPayload({ markets: { "equities-xx": false } }), ["equities-xx"]);
  rejects(() => normalizeMarketVisibilityPayload({ markets: { "equity-us": false } }), ["equity-us"]);

  rejects(() => normalizeMarketVisibilityPayload({ markets: {} }));
  rejects(() => normalizeMarketVisibilityPayload({ markets: { "equities-us": "false" } }), ["equities-us"]);
  rejects(() => normalizeMarketVisibilityPayload({ markets: { "equities-us": true }, extra: 1 }), ["extra"]);
});

test("规范化按 ID 排序，键序不改变摘要", () => {
  const first = normalizeMarketVisibilityPayload({
    markets: { "equities-us": true, "equities-au": false, "equities-cn": true },
  });
  const second = normalizeMarketVisibilityPayload({
    markets: { "equities-cn": true, "equities-us": true, "equities-au": false },
  });
  assert.deepEqual(Object.keys(first.markets), ["equities-au", "equities-cn", "equities-us"]);
  assert.deepEqual(first, second);
  assert.equal(
    runMarketVisibilityTest(family(first)).evidenceSha256,
    runMarketVisibilityTest(family(second)).evidenceSha256,
    "同一份意图必须得到同一个证据摘要",
  );
});

test("加密市场不能被隐藏", () => {
  // 加密是当前唯一进入执行路径的市场，三张官方卡都跑在上面。藏起来不会停掉 Runtime，
  // 只会让客户看不到自己组合正在交易的市场——界面与实际行为不一致。要停交易应该用
  // 紧急暂停，不是改可见性。
  const hidden = runMarketVisibilityTest(family({ markets: { [CRYPTO_MARKET_ID]: false } }));
  assert.equal(hidden.result, "failed");
  assert.deepEqual(hidden.failedChecks, ["execution_market_visible"]);

  const allowed = runMarketVisibilityTest(family({ markets: { [CRYPTO_MARKET_ID]: true, "equities-au": false } }));
  assert.equal(allowed.result, "passed");
  assert.deepEqual(allowed.failedChecks, []);
  assert.equal(allowed.testerId, "market-visibility-v1");
  assert.match(allowed.evidenceSha256, /^[a-f0-9]{64}$/);
});

test("消费者只能收窄可见性，不能凭配置新增市场", () => {
  const base = resolveMarketVisibility(null);
  assert.equal(base[CRYPTO_MARKET_ID], true);
  assert.equal(base["equities-au"], true);

  const narrowed = resolveMarketVisibility({ markets: { "equities-au": false, "equities-kr": false } });
  assert.equal(narrowed["equities-au"], false);
  assert.equal(narrowed["equities-kr"], false);
  assert.equal(narrowed["equities-us"], true, "未提及的市场保持默认");

  // 配置不是新的能力来源：注册表里没有的市场不会因为配置写了 true 就出现。
  const injected = resolveMarketVisibility({ markets: { "equities-xx": true } });
  assert.ok(!("equities-xx" in injected), "配置不得凭空新增市场");
});

test("非法配置回落到默认可见，而不是全部隐藏", () => {
  // 全部隐藏会让行情页整个空掉，这比多显示一个市场严重得多。
  for (const broken of [{ markets: null }, { markets: { "equities-xx": false } }, "not-an-object", []]) {
    const resolved = resolveMarketVisibility(broken);
    assert.equal(resolved[CRYPTO_MARKET_ID], true, "非法配置不得导致加密市场消失");
    assert.equal(resolved["equities-us"], true);
  }
});

test("注册后走严格 schema，未注册族与 schema 版本失败关闭", () => {
  const normalized = normalizeConfigurationFamilyPayload(family({ markets: { "equities-au": false } }));
  assert.deepEqual(Object.keys(normalized), ["markets"]);
  const result = runRegisteredConfigurationFamilyTest(family({ markets: { "equities-au": false } }));
  assert.equal(result.testerId, "market-visibility-v1");

  assert.equal(isMarketVisibilityFamily({ ...MARKET_VISIBILITY_FAMILY }), true);
  assert.equal(isMarketVisibilityFamily({ ...MARKET_VISIBILITY_FAMILY, schemaVersion: 2 }), false);
  assert.equal(isMarketVisibilityFamily({ ...MARKET_VISIBILITY_FAMILY, audience: "client" }), false);
  assert.equal(isMarketVisibilityFamily({ ...MARKET_VISIBILITY_FAMILY, key: "client.other" }), false);
  assert.throws(
    () => normalizeConfigurationFamilyPayload({ ...MARKET_VISIBILITY_FAMILY, key: "client.other", payload: {} }),
    (error) => error.code === "CONFIGURATION_FAMILY_UNREGISTERED",
  );
});

test("迁移加了 market kind 与最小权限 current 网关", async () => {
  const migration = await read("postgres/migrations/0077_market_visibility_configuration.sql");
  assert.match(migration, /'market'/);
  // Web 角色只拿函数执行权，不拿配置底表读权限——底表里有草稿与审批意见。
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /REVOKE ALL ON FUNCTION market_visibility_current\(text\) FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION market_visibility_current\(text\) TO agentnovas_client_web/);
  // Runtime Worker 也要读：被下架的市场不应继续驱动决策轮。
  assert.match(migration, /agentnovas_runtime_worker/);
  // 与 0071 同形状：一并返回 payload_sha256，消费者要能复核摘要。
  assert.match(migration, /payload_sha256/);
  assert.match(migration, /activation\.sequence_no DESC/);
});
