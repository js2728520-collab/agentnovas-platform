import assert from "node:assert/strict";
import test from "node:test";

import { settleFollowWeek, utcWeekBounds } from "../packages/domain/src/strategy-follow-settlement.ts";

// 默认用 live 测计费口径；paper 不收费单独测。
const settle = (overrides = {}) => settleFollowWeek({
  runMode: "live",
  weekNetPnl: "100",
  cumulativeNetPnl: "100",
  priorHighWaterMark: "0",
  feeBps: 1_800,
  platformShareBps: 5_000,
  publicationMode: "marketplace",
  ...overrides,
});

test("盈利周按合同费率计费并五五分账", () => {
  const result = settle();
  assert.equal(result.eligibleProfit, "100");
  assert.equal(result.feeAmount, "18");
  assert.equal(result.platformAmount, "9");
  assert.equal(result.authorAmount, "9");
  assert.equal(result.hasFee, true);
  assert.equal(result.nextHighWaterMark, "100");
});

test("亏损周不计费，高水位线不下降", () => {
  // INV-5：亏损周不计费，需先补回高水位线以上部分。
  const result = settle({ weekNetPnl: "-40", cumulativeNetPnl: "60", priorHighWaterMark: "100" });
  assert.equal(result.feeAmount, "0");
  assert.equal(result.hasFee, false);
  assert.equal(result.eligibleProfit, "0");
  assert.equal(result.lossCarry, "40");
  // 高水位线**不下降**。降下来会让同一段涨幅被收两次费。
  assert.equal(result.nextHighWaterMark, "100");
});

test("亏损后的反弹只对超过高水位线的部分计费", () => {
  // 上周从 100 跌到 60，本周涨回 130：只有 100→130 这 30 计费，60→100 是补回。
  const result = settle({ weekNetPnl: "70", cumulativeNetPnl: "130", priorHighWaterMark: "100" });
  assert.equal(result.eligibleProfit, "30");
  assert.equal(result.feeAmount, "5.4");
  assert.equal(result.nextHighWaterMark, "130");

  // 只涨回 90 时仍不计费。
  const partial = settle({ weekNetPnl: "30", cumulativeNetPnl: "90", priorHighWaterMark: "100" });
  assert.equal(partial.feeAmount, "0");
  assert.equal(partial.nextHighWaterMark, "100");
});

test("零费用周也出结算单", () => {
  // 「这周算过了吗」必须能回答。不出单就只能靠「没有记录」推断，而那与「还没跑」无从区分。
  const result = settle({ weekNetPnl: "0", cumulativeNetPnl: "100", priorHighWaterMark: "100" });
  assert.equal(result.hasFee, false);
  assert.equal(result.feeAmount, "0");
  assert.equal(result.platformAmount, "0");
  assert.equal(result.authorAmount, "0");
  assert.equal(result.weekNetPnl, "0");
});

test("费率来自合同快照——不同客户同一策略各按各的", () => {
  // 合同是客户当初同意的东西（INV-5）。年卡 18%、月卡 20%，同一策略同一周不同费用。
  assert.equal(settle({ feeBps: 1_800 }).feeAmount, "18");
  assert.equal(settle({ feeBps: 2_000 }).feeAmount, "20");
  assert.equal(settle({ feeBps: 1_600 }).feeAmount, "16");
  // 作者拿到的随之变化——他分的是实际收到的费用的一半，不是一个固定数。
  assert.equal(settle({ feeBps: 1_600 }).authorAmount, "8");
});

test("自用策略不产生平台收入", () => {
  const result = settle({ publicationMode: "self_use" });
  assert.equal(result.feeAmount, "18");
  assert.equal(result.platformAmount, "0");
  assert.equal(result.authorAmount, "18");
  assert.equal(result.eligibleRevenue, "0");
});

test("高水位线比较按定点整数，不按字符串", () => {
  // 字符串比大小会认为 "9" > "10"。
  const result = settle({ weekNetPnl: "1", cumulativeNetPnl: "10", priorHighWaterMark: "9" });
  assert.equal(result.nextHighWaterMark, "10");
  const negative = settle({ weekNetPnl: "-5", cumulativeNetPnl: "-5", priorHighWaterMark: "0" });
  assert.equal(negative.nextHighWaterMark, "0", "负累计不得把高水位线拉成负数");
  assert.equal(negative.feeAmount, "0");
});

test("UTC 自然周边界从周一 00:00Z 起，含头不含尾", () => {
  // 2026-08-24 是周一。
  assert.deepEqual(utcWeekBounds(new Date("2026-08-24T00:00:00.000Z")), {
    weekStart: "2026-08-24T00:00:00.000Z", weekEnd: "2026-08-31T00:00:00.000Z",
  });
  // 周日 23:59 仍属于同一周。
  assert.deepEqual(utcWeekBounds(new Date("2026-08-30T23:59:59.999Z")), {
    weekStart: "2026-08-24T00:00:00.000Z", weekEnd: "2026-08-31T00:00:00.000Z",
  });
  // 周一 00:00 属于下一周，不是上一周的尾。
  assert.equal(utcWeekBounds(new Date("2026-08-31T00:00:00.000Z")).weekStart, "2026-08-31T00:00:00.000Z");
  // 跨月与跨年不特殊。
  assert.equal(utcWeekBounds(new Date("2026-01-01T12:00:00.000Z")).weekStart, "2025-12-29T00:00:00.000Z");
  // 按 UTC 判定，不受本地时区影响：本地时间的周日晚可能已是 UTC 周一。
  assert.equal(utcWeekBounds(new Date("2026-08-24T00:00:00.000Z")).weekStart,
    utcWeekBounds(new Date("2026-08-26T18:30:00.000Z")).weekStart);
});

test("paper 与 shadow 不收费，但仍然出单并推进高水位线", () => {
  // 需求方 2026-08-24 确认：paper 跟单不收费——模拟盘没有真实收益，对它收分成等于对一笔
  // 从未发生的盈利收钱。
  for (const runMode of ["paper", "shadow"]) {
    const result = settle({ runMode });
    assert.equal(result.feeAmount, "0", `${runMode} 不应产生费用`);
    assert.equal(result.platformAmount, "0");
    assert.equal(result.authorAmount, "0");
    assert.equal(result.hasFee, false);
    // 费率按 0 传入而不是算完清零——结算单的算术必须自洽：feeBps=0 × eligibleProfit=100
    // = feeAmount=0 三者相符；照常算完再清零会留下 feeBps=1800 却 feeAmount=0，读账的人
    // 会以为记错了。
    assert.equal(result.feeBps, 0);
    // eligibleProfit 照常报告——「高水位线之上有多少利润」是客观事实，与收不收费无关。
    assert.equal(result.eligibleProfit, "100");
    // 盈亏仍然记录、高水位线仍然推进——否则将来转实盘时基准从零开始，客户会为一段
    // 模拟期的涨幅重复付费。
    assert.equal(result.weekNetPnl, "100");
    assert.equal(result.nextHighWaterMark, "100");
  }
});

test("同一周同样的盈亏，live 收费而 paper 不收", () => {
  const live = settle({ runMode: "live" });
  const paper = settle({ runMode: "paper" });
  assert.equal(live.feeAmount, "18");
  assert.equal(paper.feeAmount, "0");
  // 两者的盈亏与高水位线一致——差别只在计费。
  assert.equal(live.cumulativeNetPnl, paper.cumulativeNetPnl);
  assert.equal(live.nextHighWaterMark, paper.nextHighWaterMark);
});
