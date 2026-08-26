import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("saved strategies expose a dedicated configurable backtest and report view", async () => {
  // 回测界面的入口（遗留问卷表单）已在 P4 删除，组件与后端仍在，等待接回真实路由。
  // 只保留对组件本身的断言；描述那张表单的断言随表单一起移除。
  const [detailSource, centerSource] = await Promise.all([
    readFile(new URL("../apps/client/ui/strategy-backtest-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/client/ui/strategy-backtest-center.tsx", import.meta.url), "utf8"),
  ]);

  for (const label of ["回测预设", "实盘对齐", "探索研究", "初始资金", "手续费", "滑点", "K线数量", "回测报告", "最近交易"]) {
    assert.match(detailSource, new RegExp(label));
  }
  assert.match(detailSource, /method:\s*"POST"/);
  assert.match(detailSource, /JSON\.stringify\(options/);
  assert.match(detailSource, /encodeURIComponent\(strategyId\)/);

  assert.match(centerSource, /stream=1/);
  assert.match(centerSource, /ReadableStreamDefaultReader|response\.body\.getReader/);
  assert.match(centerSource, /aria-live="polite"/);
  assert.match(centerSource, /equityCurvePoints/);
  assert.match(centerSource, /<polyline/);
  assert.match(centerSource, /历史回测中心/);
  // 原本还断言 .strategy-equity-chart 存在于样式表里。该样式只在 P4 删除的
  // globals.css 中，这两个组件目前既没有路由也没有样式——见 DEVELOPMENT_HANDOFF
  // 「回测界面未迁移」。接回真实路由时要连样式一起按令牌重写，届时恢复该断言。
});

test("backtest API streams real phase progress while keeping JSON compatibility", async () => {
  const route = await readFile(new URL("../app/api/strategy-marketplace/[id]/backtest/route.client.ts", import.meta.url), "utf8");

  assert.match(route, /searchParams\.get\("stream"\)/);
  assert.match(route, /application\/x-ndjson/);
  for (const stage of ["validating", "market_data", "funding", "engine", "saving"]) {
    assert.match(route, new RegExp(stage));
  }
  assert.match(route, /type:\s*"completed"/);
});
