/**
 * 实盘就绪判定。
 *
 * 这份清单的作用是：任何人想打开实盘，第一件事应该是读它，而不是从代码里逐处
 * 拆闸门。上一版清单里的五条已经全部有了实现和测试：
 *
 *   LIVE_POSITION_TRACKING_MISSING     lib/live-book-posting.ts + 迁移 0062
 *   LIVE_FILLS_NOT_IN_RISK_STATE       同上（风控读数从同一本账算）
 *   LIVE_FILLS_NOT_IN_FEE_BASIS        同上 + 计费范围按 book 取数
 *   RECONCILED_RESULT_NOT_IN_RECEIPT   effective-fill.ts + 迁移 0061
 *   OKX_HAS_NO_LIVE_ADAPTER            okx-adapter 按环境参数化
 *
 * 那五处**意外**的 fail-closed（租约过滤、边界断言、requestedPrice 恒 null、
 * symbol 格式、无创建入口）也已经拆掉了。现在实盘部署可以被租走、走完决策、
 * 记账、结算，唯一停下来的地方是下面这道有名字的闸门。
 *
 * 但清单没有清空——把它清空是打开真实交易通道，而下面这三条都还立着。
 * 它们和上一版一样：不阻止下单，只让下单之后的一切慢慢变得不对。
 */

/**
 * 实盘安全运行还缺的东西。
 */
export const LIVE_EXECUTION_BLOCKERS = Object.freeze([
  {
    code: "EXCHANGE_BALANCE_NOT_RECONCILED",
    detail: "平台的账本是交易所账户的影子账，而没有任何机制核对两者是否还一致。"
      + "客户手动交易一笔、提走一部分资金、或者用同一个账户跑了别的东西，账本就会与"
      + "真实持仓分叉——而分叉不会报错。之后按账上的数量去平仓，卖的是一个数量不对的"
      + "仓位；按账上的现金去开仓，下的是一笔余额不够的单。"
      + "缺的是定期拉取交易所余额与持仓并比对，差异超阈值即熔断该部署。",
  },
  {
    code: "LIVE_ACTIVATION_ENTRY_MISSING",
    detail: "checkLiveActivation 已经把开通实盘的前置条件写成可穷举的判定，但还没有"
      + "任何客户侧入口调用它：没有申报投入资金的界面、没有实盘风险声明的确认动作、"
      + "没有把模拟部署换成实盘部署的流程。"
      + "在补上之前，实盘部署只能由运维直接建，而那条路绕过了全部前置检查。",
  },
  {
    code: "NEVER_EXECUTED_AGAINST_REAL_EXCHANGE",
    detail: "两家适配器的全部测试都跑在注入的桩上，从未对真实交易所下过一单。"
      + "最小下单额、数量步进、价格精度、限流阈值、错误码文案，这些只有真单才会暴露，"
      + "而它们出错的方式是「下单被拒」或「成交量与预期不符」——后者会直接记错账。"
      + "开通前需要用小额真实资金在每家交易所各跑通一轮完整的买入、卖出、查单、对账。",
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
