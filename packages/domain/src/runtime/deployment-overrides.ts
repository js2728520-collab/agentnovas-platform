/**
 * 部署级风控覆盖。
 *
 * 一张策略卡会被很多个部署订阅，每个部署可以带自己的仓位上限和止损线。
 * **覆盖只能收紧，不能放宽**——客户设定的上限永远不能被策略意图突破（INV-1）。
 *
 * 这条规则在平台里出现两次：这里是决策进入引擎之前收紧策略规格，
 * `execution/execution-port.ts` 的 resolveOrderQuantity 是下单换算时再收一次。
 * 两处都取「更严格者」，谁先失效都不至于让客户超限。
 */

import type { StrategyDslV3 } from "../strategy-dsl.ts";

/** null 表示该部署没有设置覆盖，沿用策略卡自身的值。 */
export type DeploymentRiskOverrides = {
  positionSizePct: number | null;
  stopLossPct: number | null;
};

/** 取更严格者。覆盖值缺失时保持原值不动。 */
function tighten(base: number, override: number | null) {
  return override === null ? base : Math.min(base, override);
}

export function applyDeploymentRiskOverrides(
  base: StrategyDslV3,
  overrides: DeploymentRiskOverrides,
): StrategyDslV3 {
  const leg = <T extends { stopLossPct: number }>(value: T): T => ({
    ...value,
    stopLossPct: tighten(value.stopLossPct, overrides.stopLossPct),
  });
  return {
    ...base,
    legs: {
      ...(base.legs.long ? { long: leg(base.legs.long) } : {}),
      ...(base.legs.short ? { short: leg(base.legs.short) } : {}),
    },
    risk: {
      ...base.risk,
      positionSizePct: tighten(base.risk.positionSizePct, overrides.positionSizePct),
    },
  };
}
