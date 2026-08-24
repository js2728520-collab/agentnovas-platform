import assert from "node:assert/strict";
import test from "node:test";

import { splitFollowPerformanceFee } from "../packages/domain/src/commercial-membership-domain.ts";
import { FOLLOW_FEES } from "../packages/contracts/src/product-parameters.ts";
import { DEFAULT_FOLLOW_FEE_BPS, PLATFORM_SHARE_BPS } from "../lib/strategy-follow-contract.ts";

const split = (feeAmount, platformShareBps = 5_000, publicationMode = "marketplace") =>
  splitFollowPerformanceFee({ feeAmount, platformShareBps, publicationMode });

test("bps 常量取自已冻结的 P-06", () => {
  assert.equal(PLATFORM_SHARE_BPS, 5_000);
  assert.equal(DEFAULT_FOLLOW_FEE_BPS, 2_000);
  assert.equal(FOLLOW_FEES.platformShareRate, "0.50");
  assert.equal(FOLLOW_FEES.performanceFeeRate, "0.20");
  // 作者与平台两份必须互补，否则总有一边多拿。
  assert.equal(Number(FOLLOW_FEES.authorShareRate) + Number(FOLLOW_FEES.platformShareRate), 1);
});

/** 按 18 位定点整数比较，避免用浮点验证一个刻意避开浮点的实现。 */
function units(value) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}

test("平台份加作者份恒等于总额", () => {
  // 账本要求借贷必平（INV-4）。两边各自取整会漏出一个谁也不属于的尾差。
  const amounts = ["0", "20", "0.000000000000000001", "0.000000000000000003", "1.005", "33.333333333333333333"];
  for (const amount of amounts) {
    for (const bps of [0, 1, 2_500, 5_000, 7_777, 10_000]) {
      const { feeAmount, platformAmount, authorAmount } = split(amount, bps);
      assert.equal(
        units(platformAmount) + units(authorAmount),
        units(feeAmount),
        `${amount} @ ${bps}bps 拆分后总额不守恒`,
      );
    }
  }
});

test("尾差归作者，不归平台", () => {
  // 取整方向必须写死在一处并说明白。让平台承接尾差意味着系统性地偏向自己一侧。
  const result = split("0.000000000000000001", 5_000);
  assert.equal(result.platformAmount, "0");
  assert.equal(result.authorAmount, "0.000000000000000001");

  const odd = split("0.000000000000000003", 5_000);
  assert.equal(odd.platformAmount, "0.000000000000000001");
  assert.equal(odd.authorAmount, "0.000000000000000002");
});

test("50/50 拆分与自用策略", () => {
  assert.deepEqual(split("20"), {
    feeAmount: "20", platformAmount: "10", authorAmount: "10", eligibleRevenue: "10",
  });
  // 作者跟自己的策略，平台没有中介角色可言。
  assert.deepEqual(split("20", 5_000, "self_use"), {
    feeAmount: "20", platformAmount: "0", authorAmount: "20", eligibleRevenue: "0",
  });
  // 只有平台那一份进分销收入池；作者那份是成本不是收入。
  assert.equal(split("20").eligibleRevenue, split("20").platformAmount);
});

test("非法输入直接拒绝，不静默产出一个数", () => {
  assert.throws(() => split("20", -1), /PLATFORM_SHARE_BPS_INVALID/);
  assert.throws(() => split("20", 10_001), /PLATFORM_SHARE_BPS_INVALID/);
  assert.throws(() => split("20", 1.5), /PLATFORM_SHARE_BPS_INVALID/);
  assert.throws(() => split("-1"), /FOLLOW_FEE_NEGATIVE/);
  assert.throws(() => split("abc"), /INVALID_DECIMAL/);
});
