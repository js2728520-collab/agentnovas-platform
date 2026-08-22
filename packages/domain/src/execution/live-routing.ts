/**
 * 实盘路由准入。
 *
 * 前五步都是在加保护，这一步是把保护往回放一点——因此它是全仓库最需要说清楚
 * 「什么不能被配置改变」的地方。
 *
 * 三条规则，前两条**不可配置**：
 *
 * **1. 只有现货。** 永续合约的路由在本平台是硬关闭的，不存在任何开关能打开它
 * （见根 AGENTS.md 与 `lib/beta-legacy-runtime-guard.ts`）。把它做成配置项，就等于
 * 迟早有人在某个深夜把它打开。
 *
 * **2. 只有买入方向的开仓受限，平仓永不受限。** 与熔断、对账一致：退出能力不依赖
 * 任何一层在线或任何一项配置（INV-7）。
 *
 * **3. 逐个交易所灰度。** 开通是按 (交易所, 环境) 逐条批准的，没有「全部打开」这个
 * 动作。默认全关。
 */

/** 部署的执行标的。本平台只做 USDT 现货。 */
export type ExecutionProduct = "spot_usdt" | "usdt_perpetual";

export type ExchangeEnvironment = "demo" | "live";

export type LiveRoutingGrant = {
  exchange: string;
  /** 已批准的环境。demo 与 live 分别批准，开通 demo 不等于开通实盘。 */
  environment: ExchangeEnvironment;
};

export type LiveRoutingQuery = {
  exchange: string;
  environment: ExchangeEnvironment;
  product: ExecutionProduct;
  grants: readonly LiveRoutingGrant[];
};

export type LiveRoutingDecision = { allowed: boolean; reason: string | null };

/**
 * 永续路由在任何配置下都不被允许。
 *
 * 这不是一个默认值，是一条常量规则：即使有人往授权表里塞一条永续的记录，
 * 这里也会挡住。配置错误不该等于风控失效。
 */
export function isRoutableProduct(product: ExecutionProduct): boolean {
  return product === "spot_usdt";
}

export function resolveLiveRouting(query: LiveRoutingQuery): LiveRoutingDecision {
  if (!isRoutableProduct(query.product)) {
    return { allowed: false, reason: "PERPETUAL_ROUTING_FORBIDDEN" };
  }
  const exchange = query.exchange.trim().toLowerCase();
  if (!exchange) return { allowed: false, reason: "EXCHANGE_UNKNOWN" };

  const granted = query.grants.some((grant) =>
    grant.exchange.trim().toLowerCase() === exchange && grant.environment === query.environment);
  if (!granted) {
    // demo 与 live 分开授权，所以拒绝原因要带上环境，否则运营会以为「我明明开通了」。
    return {
      allowed: false,
      reason: query.environment === "live" ? "LIVE_ROUTING_NOT_GRANTED" : "DEMO_ROUTING_NOT_GRANTED",
    };
  }
  return { allowed: true, reason: null };
}
