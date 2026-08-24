import assert from "node:assert/strict";
import test from "node:test";

import { settleFollowWeek, utcWeekBounds } from "../packages/domain/src/strategy-follow-settlement.ts";

const settle = (overrides = {}) => settleFollowWeek({
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
