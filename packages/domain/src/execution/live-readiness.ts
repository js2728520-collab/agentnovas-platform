/**
 * 实盘就绪判定。
 *
 * 现状：**实盘链路没有接通。** 一条真实订单都发不出去，而且是被五处互相独立的
 * 检查各自挡住的：
 *
 * 1. `leaseNextStrategyDeployment` 过滤 `exchange_account_id IS NULL` —— live 部署
 *    永远租不走；
 * 2. `processOfficialSpotRuntimeDeployment` 开头 `exchangeAccountId !== null` 就抛
 *    「官方现货部署边界不一致」；
 * 3. 引擎只在止损/止盈两条离场分支给 `requestedPrice` 赋值，`enter_long` 恒为 null
 *    → 翻译抛 `REQUESTED_PRICE_INVALID`；
 * 4. 策略规格的 symbol 是 `BTCUSDT`，而订单意图要求 `BTC/USDT`
 *    → 抛 `INTENT_SYMBOL_INVALID`；
 * 5. 没有任何 API 能创建 `mode='live'` 的部署。
 *
 * 五处都是 fail-closed，所以现状是安全的。**但它们是意外的，不是设计的。**
 * 危险在于：逐个把它们「修好」，每一步看起来都像修 bug，而全部修完之后打开的是
 * 一条记账不成立的真实交易通道。
 *
 * 因此把前置条件集中写在这里：任何人想打开实盘，第一件事应该是读这个清单，
 * 而不是从第 1 条开始逐个拆。
 */

/**
 * 实盘安全运行还缺的东西。
 *
 * 前四条是**记账缺口**，比上面那五处阻断严重得多——它们不阻止下单，它们让下单
 * 之后的一切都是错的。
 */
export const LIVE_EXECUTION_BLOCKERS = Object.freeze([
  {
    code: "LIVE_POSITION_TRACKING_MISSING",
    detail: "实盘成交不写任何仓位表。Worker 里 position 仅在 mode==='paper' 时加载，"
      + "live 恒为 null，于是引擎只会不断产出开仓意图，永远不产出平仓意图——"
      + "既无限加仓，客户又无法通过平台离场。",
  },
  {
    code: "LIVE_FILLS_NOT_IN_RISK_STATE",
    detail: "回撤与日亏取自 paper 组合净值。实盘成交不进那张表，于是 drawdownPct 与 "
      + "dailyLossPct 恒为 0，客户自己的风控预算在实盘上被静默旁路。",
  },
  {
    code: "LIVE_FILLS_NOT_IN_FEE_BASIS",
    detail: "绩效分成以 paper 组合的模拟成交为准。live_execution_receipts 零读取方，"
      + "实盘盈亏既不进仓位也不进分成。",
  },
  {
    code: "RECONCILED_RESULT_NOT_IN_RECEIPT",
    detail: "回执按下单响应写死且不可改写，对账结案的事实回不到回执。市价单在响应之后"
      + "才成交时，回执会永久停在 rejected 而对账记录是 filled，两张表互相矛盾。",
  },
  {
    code: "OKX_HAS_NO_LIVE_ADAPTER",
    detail: "okx-demo-execution 无条件发 x-simulated-trading: 1，没有实盘参数。"
      + "okx/live 目前没有适配器，只有 binance 有。",
  },
] as const);

export type LiveExecutionBlocker = (typeof LIVE_EXECUTION_BLOCKERS)[number];

/**
 * 实盘是否可以安全运行。
 *
 * 恒为 false，直到上面的清单被清空。这不是一个开关——把它改成 true 之前，
 * 清单里每一条都必须有对应的实现和测试。
 */
export function isLiveExecutionReady(): boolean {
  // 用宽化后的长度比较：直接写 `LIVE_EXECUTION_BLOCKERS.length === 0` 会因为元组
  // 字面量类型被 TypeScript 判成「恒假」而报错。清单清空后这里自然返回 true。
  const remaining: number = LIVE_EXECUTION_BLOCKERS.length;
  return remaining === 0;
}

export function describeLiveExecutionBlockers(): string {
  return LIVE_EXECUTION_BLOCKERS.map((blocker) => `${blocker.code}: ${blocker.detail}`).join("\n");
}
