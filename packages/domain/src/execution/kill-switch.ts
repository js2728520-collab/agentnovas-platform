/**
 * 熔断开关（kill switch）。
 *
 * 运营可以按三个维度暂停新开仓：交易所、客户账户、策略卡。三个维度是并列的——
 * 命中任意一个就挡住，因为它们对应三种不同的事故：交易所出问题、某个客户的账户
 * 出问题、某张策略卡出问题。
 *
 * **两个动作的门槛必须不对称，这是本文件最重要的设计判断：**
 *
 * - **挂上开关是单人即时生效的。** 出事的时候没有时间等第二个人批准。
 *   要求双人复核才能停止交易，等于在最需要停下来的那一刻停不下来。
 * - **摘掉开关要走 maker/checker。** 恢复交易是把风险放回去，这才是需要第二双
 *   眼睛的方向。
 *
 * 把这条对称性写反的系统看起来「更严格」，实际更危险。
 *
 * 与对账准入一样：**只挡开仓，永不挡平仓。** 退出能力不依赖任何一层在线。
 */

import { admitNewEntry, type AccountReconciliationState, type EntryAdmission } from "./reconciliation.ts";

export type KillSwitchDimension = "exchange" | "account" | "strategy";

export type ActiveKillSwitch = {
  dimension: KillSwitchDimension;
  /** 该维度下被暂停的具体对象：交易所代号、账户 id、策略卡代号。 */
  scopeValue: string;
  reason: string;
};

export type OrderContext = {
  exchange: string;
  accountId: string;
  /** 该笔下单来自哪张策略卡。没有策略卡来源时传 null（例如手动平仓）。 */
  strategyCode: string | null;
};

function scopeValueFor(dimension: KillSwitchDimension, context: OrderContext): string | null {
  if (dimension === "exchange") return context.exchange;
  if (dimension === "account") return context.accountId;
  return context.strategyCode;
}

/** 交易所代号大小写不敏感；账户 id 与策略卡代号必须精确匹配。 */
function matches(entry: ActiveKillSwitch, context: OrderContext): boolean {
  const value = scopeValueFor(entry.dimension, context);
  if (value === null) return false;
  if (entry.dimension === "exchange") {
    return entry.scopeValue.toLowerCase() === value.toLowerCase();
  }
  return entry.scopeValue === value;
}

export type KillSwitchResolution = { blocked: boolean; matched: ActiveKillSwitch | null };

export function resolveKillSwitch(
  switches: readonly ActiveKillSwitch[],
  context: OrderContext,
): KillSwitchResolution {
  const matched = switches.find((entry) => matches(entry, context)) ?? null;
  return { blocked: matched !== null, matched };
}

export type OrderSideForAdmission = "buy" | "sell";

export type OrderAdmissionInput = {
  side: OrderSideForAdmission;
  context: OrderContext;
  symbol: string;
  killSwitches: readonly ActiveKillSwitch[];
  reconciliation: AccountReconciliationState;
};

/**
 * 下单准入的唯一入口。
 *
 * 把熔断与对账两道闸门合在这里，是为了让「平仓永不被挡」这条规则只存在于一个
 * 地方。分散在两处迟早会有一处漏掉——而漏掉的后果是客户在事故中离不了场，
 * 恰恰是熔断本该保护他免于遭遇的处境。
 */
export function admitOrder(input: OrderAdmissionInput): EntryAdmission {
  // 平仓无条件放行。这一行是本文件与 reconciliation.ts 共同的底线（INV-7）。
  if (input.side === "sell") return { allowed: true, reason: null };

  const killSwitch = resolveKillSwitch(input.killSwitches, input.context);
  if (killSwitch.blocked && killSwitch.matched) {
    return { allowed: false, reason: `KILL_SWITCH_${killSwitch.matched.dimension.toUpperCase()}` };
  }
  return admitNewEntry(input.reconciliation, input.symbol);
}
