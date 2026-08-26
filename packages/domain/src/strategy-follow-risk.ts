/**
 * 跟单的自动风控判定（T4.4b）。
 *
 * 需求方确认：**用合同里客户自己设的止损线**，不另设一组平台运行时阈值。理由是客户
 * 同意过那个数字——不会被一个他从未看过的阈值意外停掉，而且不同风险偏好的客户各自适用。
 *
 * P-05 那组按档位的回撤阈值是**准入标准**（这个策略能不能上架），不是运行中的停机线。
 * 两者混用会让一个保守档策略的客户在 10% 回撤时被停，即使他自己设的是 20%。
 *
 * 纯函数：不读库、不知道回撤是怎么算出来的。判定只回答「该不该阻断」，不执行阻断。
 */

export type FollowRiskFacts = {
  /** 相对该跟随历史最高权益的回撤百分比，正数表示亏损。 */
  drawdownPct: number;
  /** 来自跟单合同的止损线快照（`risk_json.stopLossPct`）。 */
  stopLossPct: number;
  /** 该策略当前的上架状态。 */
  listingStatus: string;
  /** 下架原因。区分作者主动与平台风险，两者对存量跟随者的处理完全不同。 */
  delistReason: string | null;
};

export type FollowRiskVerdict = {
  /** 是否应当阻断。 */
  blocked: boolean;
  /** 触发的规则，供界面与审计说明「为什么被停」。空表示未触发。 */
  triggeredRules: string[];
  /** 判定依据的实际值与阈值，让客户能核对而不是只看到「被风控停了」。 */
  evidence: { drawdownPct: number; stopLossPct: number; listingStatus: string };
};

/** 平台因风险或合规下架——存量跟随者自动阻断。作者主动下架不在此列。 */
export const PLATFORM_RISK_DELIST_REASONS = ["platform_risk", "platform_compliance"] as const;

export function isPlatformRiskDelist(reason: string | null | undefined): boolean {
  return typeof reason === "string" && (PLATFORM_RISK_DELIST_REASONS as readonly string[]).includes(reason);
}

export function evaluateFollowRisk(facts: FollowRiskFacts): FollowRiskVerdict {
  const triggeredRules: string[] = [];

  // 回撤触线。止损线缺失或无效时**不触发**——一个坏掉的阈值不该变成「立刻停掉所有人」。
  // 方向与准入判定相反是有意的：准入是「证据不足就拒绝」，这里是「证据不足就不擅自行动」，
  // 因为这里的行动会打断一个正在运行的仓位。
  const validStopLoss = Number.isFinite(facts.stopLossPct) && facts.stopLossPct > 0;
  if (validStopLoss && Number.isFinite(facts.drawdownPct) && facts.drawdownPct >= facts.stopLossPct) {
    triggeredRules.push("drawdown_stop_loss");
  }

  // 平台因风险或合规下架：存量跟随者自动阻断（需求方确认）。作者主动下架走 7 天通知
  // 缓冲期，不在这里阻断——两种下架的性质完全不同，合并处理会让其中一种错。
  if (facts.listingStatus === "delisted" && isPlatformRiskDelist(facts.delistReason)) {
    triggeredRules.push("platform_risk_delisting");
  }

  return {
    blocked: triggeredRules.length > 0,
    triggeredRules,
    evidence: {
      drawdownPct: Number.isFinite(facts.drawdownPct) ? facts.drawdownPct : Number.NaN,
      stopLossPct: validStopLoss ? facts.stopLossPct : Number.NaN,
      listingStatus: facts.listingStatus,
    },
  };
}
