import { splitFollowPerformanceFee } from "../packages/domain/src/commercial-membership-domain.ts";
import { FOLLOW_FEES } from "../packages/contracts/src/product-parameters.ts";

/**
 * 绩效分成的平台/作者拆分。
 *
 * 分账比例取自已冻结的 P-06，不再是代码里的 `.5` 字面量——改分账比例应该是改产品参数，
 * 而不是改一个散落在函数体里的数字。
 *
 * 实际拆分交给 `splitFollowPerformanceFee` 做整数运算：这里的 number 接口是给既有调用方
 * 与展示用的，钱的精度由域层的 BigInt 口径保证，两边不各算一遍。
 */
export function splitStrategyPerformanceFee(
  grossPerformanceFeeUsdt: number,
  collectionStatus: "confirmed" | "pending" | "failed" | "reversed" = "confirmed",
  publicationMode: "marketplace" | "self_use" = "marketplace",
) {
  const gross = Math.round(grossPerformanceFeeUsdt * 1e6) / 1e6;
  if (!Number.isFinite(gross) || gross < 0) throw new Error("绩效分成金额无效");
  // 未确认收款前不产生任何分账。作者的钱只能来自平台真的收到的钱。
  if (collectionStatus !== "confirmed") {
    return { grossPerformanceFeeUsdt: gross, platformFeeUsdt: 0, authorAmountUsdt: 0, eligibleRevenueUsdt: 0 };
  }
  const split = splitFollowPerformanceFee({
    feeAmount: gross.toFixed(6),
    platformShareBps: Math.round(Number(FOLLOW_FEES.platformShareRate) * 10_000),
    publicationMode,
  });
  return {
    grossPerformanceFeeUsdt: gross,
    platformFeeUsdt: Number(split.platformAmount),
    authorAmountUsdt: Number(split.authorAmount),
    eligibleRevenueUsdt: Number(split.eligibleRevenue),
  };
}
