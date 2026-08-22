/**
 * 策略冒烟测试的判定。
 *
 * 「策略能正常运行」的定义不是「DSL 合法」，而是「放进回测引擎跑得完、
 * 并且真的会触发信号」。静态校验挡不住这两类问题：
 *
 * - 指标周期比可用 K 线还长——DSL 完全合法，跑起来永远算不出指标；
 * - 条件树永远不成立——DSL 完全合法，跑完一整段历史一笔都不开。
 *
 * 两者都会在保存时看起来成功，等客户部署之后才发现什么都没发生。
 *
 * 这里**不看收益**。净值、胜率、盈亏比一概不参与判定——判定只回答
 * 「这条策略能不能跑起来」。
 */

/** 通过冒烟测试所需的最少信号数。零信号的策略是惰性的，不是能跑的。 */
export const MINIMUM_SMOKE_SIGNALS = 1;

export type StrategySmokeVerdict =
  | { status: "passed"; signals: number }
  | { status: "failed"; reason: string; signals: number }
  /** 行情不可用等外部原因导致没跑成。不是策略的问题，但也**不能当作通过**（INV-6）。 */
  | { status: "skipped"; reason: string };

export function evaluateStrategySmokeTest(result: {
  sampleSize: number;
  liquidated: boolean;
  candleCount: number;
}): StrategySmokeVerdict {
  const signals = Number.isSafeInteger(result.sampleSize) && result.sampleSize >= 0 ? result.sampleSize : 0;
  if (result.liquidated) {
    return { status: "failed", reason: "回测期内触发强平，风控参数不可用", signals };
  }
  if (signals < MINIMUM_SMOKE_SIGNALS) {
    return {
      status: "failed",
      reason: `在 ${result.candleCount} 根 K 线上从未触发交易信号，条件可能永远不成立`,
      signals,
    };
  }
  return { status: "passed", signals };
}

/** 面向客户的一句话说明。保存记录里会带上它，不让「未验证」看起来像「已通过」。 */
export function describeStrategySmokeVerdict(verdict: StrategySmokeVerdict): string {
  if (verdict.status === "passed") return `冒烟回测通过：触发 ${verdict.signals} 次交易信号（不代表收益）。`;
  if (verdict.status === "skipped") return `冒烟回测未执行：${verdict.reason}。该策略尚未验证可运行性。`;
  return `冒烟回测未通过：${verdict.reason}。`;
}
