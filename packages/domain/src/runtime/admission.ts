/**
 * 组合级准入是否需要留痕。
 *
 * 决策轮是共享的（同一张卡、同一根 K 线只判断一次），准入是逐组合的。
 * 但多数 K 线的结论是「不动作」——若为每个组合都写一行准入结果，
 * 5,000 会员 × 3 张卡在 15m 周期下每天约 144 万行，需要分区维护。
 *
 * 已定的产品决策：**纯 hold 不为每个组合留痕**。客户视图从共享决策轮读到
 * 「本轮无动作」即可——卡级结论就是本轮不动作，这不是信息缺失。
 *
 * 反过来，只要发生了**对这个客户特有**的事，就必须留痕：产生订单意图、
 * 组合级风控拒绝、或访问状态导致降级。那些是「同一轮里这个客户与别人不同」
 * 的地方，不留痕就没法回答「为什么我没成交而他成交了」。
 */

export type AdmissionOutcome = {
  action: string;
  riskApproved: boolean;
  hasOrderIntent: boolean;
  /** 组合级拒绝理由（风控读数不可用、熔断、访问状态降级等）。 */
  rejectionReasons?: readonly string[];
};

export function shouldPersistAdmission(outcome: AdmissionOutcome): boolean {
  if (outcome.hasOrderIntent) return true;
  if (outcome.riskApproved === false) return true;
  if (outcome.rejectionReasons && outcome.rejectionReasons.length > 0) return true;
  // 只剩「风控放行且没有动作」——那就是纯 hold，与卡级结论完全一致。
  return outcome.action !== "hold";
}

/** 面向客户的一句话：为什么这一轮查不到属于我的记录。 */
export const NO_ADMISSION_RECORD_REASON =
  "本轮该策略卡的结论是不动作，因此没有产生属于你的单独记录。七阶段结论见本卡的公共决策轮。";
