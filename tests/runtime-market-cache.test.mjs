import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isMarketSnapshotReusable,
  marketCacheKey,
  timeframeMilliseconds,
} from "../packages/domain/src/runtime/market-cache.ts";

// 行情复用。
//
// 官方现货是「每个 (客户, 策略卡) 一个部署」：5,000 会员 × 3 张卡 = 15,000 个部署，
// 而三张卡合计只有 6 种 (品种, 周期) 组合。不复用就是同一份 K 线拉 2,500 次，
// 打公开行情接口必然触发限流。

const HOUR = 3_600_000;

test("周期换算覆盖平台在用的全部周期", () => {
  assert.equal(timeframeMilliseconds("15m"), 900_000);
  assert.equal(timeframeMilliseconds("1h"), HOUR);
  assert.equal(timeframeMilliseconds("4h"), 4 * HOUR);
});

test("未知周期返回 null，调用方据此放弃复用而不是猜时长", () => {
  // INV-7 失败安全：猜一个时长会让决策用错 K 线。
  assert.equal(timeframeMilliseconds("7m"), null);
  assert.equal(isMarketSnapshotReusable({ fetchedAt: 0, now: 1, timeframe: "7m" }), false);
});

test("同一根 K 线周期内可以复用", () => {
  const base = 10 * HOUR;
  assert.equal(isMarketSnapshotReusable({ fetchedAt: base + 60_000, now: base + 3_000_000, timeframe: "1h" }), true);
});

test("新 K 线一收盘立即失效", () => {
  // 用固定 TTL 会让决策落在上一根 K 线上，违反 INV-8「决策绑定具体已收盘 K 线」。
  const base = 10 * HOUR;
  assert.equal(isMarketSnapshotReusable({ fetchedAt: base + 3_599_999, now: base + HOUR, timeframe: "1h" }), false);
});

test("15m 与 1h 各自按自己的周期判定", () => {
  const base = 10 * HOUR;
  const later = base + 1_000_000; // 超过 15m，未超过 1h
  assert.equal(isMarketSnapshotReusable({ fetchedAt: base, now: later, timeframe: "15m" }), false);
  assert.equal(isMarketSnapshotReusable({ fetchedAt: base, now: later, timeframe: "1h" }), true);
});

test("时间倒流或非有限值不复用", () => {
  const base = 10 * HOUR;
  assert.equal(isMarketSnapshotReusable({ fetchedAt: base, now: base - 1, timeframe: "1h" }), false);
  assert.equal(isMarketSnapshotReusable({ fetchedAt: Number.NaN, now: base, timeframe: "1h" }), false);
  assert.equal(isMarketSnapshotReusable({ fetchedAt: base, now: Infinity, timeframe: "1h" }), false);
});

test("缓存键区分品种、周期与条数", () => {
  assert.notEqual(marketCacheKey("BTCUSDT", "1h", 500), marketCacheKey("ETHUSDT", "1h", 500));
  assert.notEqual(marketCacheKey("BTCUSDT", "1h", 500), marketCacheKey("BTCUSDT", "15m", 500));
  assert.notEqual(marketCacheKey("BTCUSDT", "1h", 500), marketCacheKey("BTCUSDT", "1h", 200));
});

test("worker 的缓存实现共享 Promise 且失败不留坏条目", async () => {
  // 这两条无法脱离进程状态单测，用源码契约断言（仓库既有做法）。
  const worker = await readFile(new URL("../lib/strategy-runtime-worker.ts", import.meta.url), "utf8");
  // 并发的 15,000 个部署不能同时穿透缓存去打行情接口。
  assert.match(worker, /payload: Promise<SpotCandlePayload>/);
  // 失败的请求若留在缓存里，会在整个 K 线周期内被反复复用。
  assert.match(worker, /payload\.catch\(\(\) => \{[\s\S]*spotCandleCache\.delete\(key\)/);
  assert.match(worker, /isMarketSnapshotReusable/);
});
