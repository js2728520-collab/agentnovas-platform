/**
 * 执行端口。
 *
 * 域层声明「意图要被执行」这件事需要什么，但不实现它。当前只有 paper 实现；
 * GA 接入真实交易时新增 real 实现，域层零改动。
 *
 * 两条实现必须始终分开：
 * - 客户 paper 回执与平台 Demo 回执永不混写（INV-2）；
 * - 真实执行必须跑在独立进程、独立网段，是全系统唯一能解密交易所凭证并签名的
 *   地方。凭证不出现在本文件的任何类型里，域层也无从触碰（INV-11）。
 */

import type { OrderIntent } from "./order-intent.ts";

/** 执行环境。paper 是服务器记账；platform_demo 只产出平台自己的技术证据。 */
export type ExecutionVenue = "paper" | "platform_demo" | "live";

export type ExecutionOutcome = "filled" | "partial" | "rejected" | "expired";

export type ExecutionReceipt = {
  intentId: string;
  venue: ExecutionVenue;
  outcome: ExecutionOutcome;

  /** 实际成交数量与均价。被拒或过期时为 0。 */
  filledQuantity: number;
  averagePrice: number;
  feeAmount: number;

  /** 被拒时必须给出原因，不允许空着——INV-6 要求失败显式可见。 */
  rejectionReason: string | null;

  /** 交易所返回的订单号；paper 执行为 null。 */
  externalOrderId: string | null;
  executedAt: string;
};

/**
 * 一条意图扇出到一个具体组合时的执行请求。
 *
 * 意图本身只带「目标仓位比例」，换算成实际下单量需要该组合的可用资金——
 * 这个数字属于账户状态，由执行端从仓储读取后填入，不经过域层。
 */
export type ExecutionRequest = {
  intent: OrderIntent;
  portfolioId: string;
  /** 该组合当前可动用的计价货币金额。 */
  availableCapital: number;
  /** 该组合订阅时设定的单笔资金上限比例，与意图的目标比例取更严格者。 */
  capitalCapRatio: number;
};

export type ExecutionPort = {
  readonly venue: ExecutionVenue;

  /**
   * 执行一批请求。
   *
   * 刻意设计成批量：一轮决策会扇出到该策略卡的全部订阅组合，5000 会员就是
   * 5000 次调用。paper 实现可以在一个事务里批量记账；真实实现必须自己处理
   * 限流、重试、部分失败与对账——那是执行端的责任，不是域层的。
   *
   * 返回的回执数量必须与请求一致：每条请求都要有明确结果，不允许静默丢弃。
   */
  execute(requests: ExecutionRequest[]): Promise<ExecutionReceipt[]>;
};

/**
 * 换算实际下单量。
 *
 * 取「意图目标比例」与「组合资金上限比例」中更严格的一个——客户设定的上限
 * 永远不能被策略意图突破。这是纯计算，放在域层，好让 paper 与 real 用同一套
 * 换算逻辑，避免两边算出不同的仓位。
 */
export function resolveOrderQuantity(request: ExecutionRequest, referencePrice: number): number {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error("EXECUTION_REFERENCE_PRICE_INVALID");
  }
  const ratio = Math.min(request.intent.targetPositionRatio, request.capitalCapRatio);
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  const notional = request.availableCapital * ratio;
  if (!Number.isFinite(notional) || notional <= 0) return 0;
  return notional / referencePrice;
}
