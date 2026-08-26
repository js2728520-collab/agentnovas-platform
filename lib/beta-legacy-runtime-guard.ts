/**
 * 永续运行时的硬关闭。
 *
 * **不要因为「要开实盘了」而移除本文件。** 它挡的不是实盘，是永续：
 * `assertBetaSpotRuntimeLease` 只放行 `spot_usdt`，移除它会打开
 * `usdt_perpetual` 的部署路径——正是根 AGENTS.md 明令必须保持关闭的东西。
 *
 * ADR-0019 的实施顺序里一度写着「打开实盘路由（移除 assertBetaSpotRuntimeLease
 * 的硬关闭）」，那句话是错的，已在该 ADR 第 6 步的记录里更正。
 *
 * 实盘路由由 `execution_live_routing` 授权表按 (交易所, 环境) 逐条控制，
 * 与本文件无关。
 */

export class BetaLegacyRuntimeDisabledError extends Error {
  constructor(component: "research" | "runtime") {
    super(component === "research"
      ? "Beta 已关闭 legacy 永续策略研发运行时"
      : "Beta 已关闭 legacy 永续策略部署运行时");
    this.name = "BetaLegacyRuntimeDisabledError";
  }
}

export function assertBetaResearchRuntimeDisabled(): void {
  throw new BetaLegacyRuntimeDisabledError("research");
}

export function assertBetaSpotRuntimeLease(executionProduct: string): void {
  if (executionProduct !== "spot_usdt") throw new BetaLegacyRuntimeDisabledError("runtime");
}
