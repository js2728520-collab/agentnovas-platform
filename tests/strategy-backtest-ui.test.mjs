import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("saved strategies expose a dedicated configurable backtest and report view", async () => {
  const [detailSource, centerSource, workspaceSource, styles] = await Promise.all([
    readFile(new URL("../app/strategy-backtest-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/strategy-backtest-center.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/community-strategy-center.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  for (const label of ["回测预设", "实盘对齐", "探索研究", "初始资金", "手续费", "滑点", "K线数量", "回测报告", "最近交易"]) {
    assert.match(detailSource, new RegExp(label));
  }
  assert.match(detailSource, /method:\s*"POST"/);
  assert.match(detailSource, /JSON\.stringify\(options/);
  assert.match(detailSource, /encodeURIComponent\(strategyId\)/);
  assert.match(workspaceSource, /StrategyBacktestDetail/);
  assert.match(workspaceSource, /StrategyBacktestCenter/);
  assert.match(workspaceSource, /查看策略/);
  assert.match(workspaceSource, /快速回测/);
  assert.match(workspaceSource, /分享到策略广场/);
  assert.match(workspaceSource, /createdAt/);
  assert.match(workspaceSource, /type="button"[\s\S]*策略列表/);
  assert.match(workspaceSource, /type="button"[\s\S]*回测与模拟/);
  assert.match(workspaceSource, /<details className="studio-factor-library"/);

  assert.match(centerSource, /stream=1/);
  assert.match(centerSource, /ReadableStreamDefaultReader|response\.body\.getReader/);
  assert.match(centerSource, /aria-live="polite"/);
  assert.match(centerSource, /equityCurvePoints/);
  assert.match(centerSource, /<polyline/);
  assert.match(centerSource, /历史回测中心/);
  assert.match(styles, /\.strategy-equity-chart/);
});

test("backtest API streams real phase progress while keeping JSON compatibility", async () => {
  const route = await readFile(new URL("../app/api/strategy-marketplace/[id]/backtest/route.ts", import.meta.url), "utf8");

  assert.match(route, /searchParams\.get\("stream"\)/);
  assert.match(route, /application\/x-ndjson/);
  for (const stage of ["validating", "market_data", "funding", "engine", "saving"]) {
    assert.match(route, new RegExp(stage));
  }
  assert.match(route, /type:\s*"completed"/);
});
