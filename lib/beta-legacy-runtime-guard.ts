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
