import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("saved strategies expose a dedicated configurable backtest and report view", async () => {
  const [detailSource, centerSource] = await Promise.all([
    readFile(new URL("../app/strategy-backtest-detail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/community-strategy-center.tsx", import.meta.url), "utf8"),
  ]);

  for (const label of ["回测预设", "实盘对齐", "探索研究", "初始资金", "手续费", "滑点", "K线数量", "回测报告", "最近交易"]) {
    assert.match(detailSource, new RegExp(label));
  }
  assert.match(detailSource, /method:\s*"POST"/);
  assert.match(detailSource, /JSON\.stringify\(options/);
  assert.match(detailSource, /encodeURIComponent\(strategyId\)/);
  assert.match(centerSource, /StrategyBacktestDetail/);
  assert.match(centerSource, /查看策略/);
  assert.match(centerSource, /selectedStrategyId/);
});
