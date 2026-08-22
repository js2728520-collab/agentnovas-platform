/**
 * 真实 ExecutionPort（ADR-0019 第 3 步）。
 *
 * 只在执行服务进程里运行——它是全系统唯一能解密交易所凭证的地方。
 *
 * **本文件不打开实盘路由。** 是否真的往交易所发单由 `LIVE_EXECUTION_ENABLED`
 * 控制，默认关闭，第 6 步才按交易所逐个灰度（见 AGENTS.md：真实合约订单路由必须
 * 保持关闭）。现在把实现和它的单测做完，是为了让第 6 步只剩「打开开关」这一个
 * 动作，而不是在开实盘的当天才第一次写这段代码。
 *
 * 交易所访问通过注入的适配器进行，于是这段编排（幂等 id、限流、分类、失败隔离）
 * 可以用假适配器完整测试，不需要网络，也不需要任何真实凭证。
 */

import type {
  ExecutionPort,
  ExecutionReceipt,
  ExecutionRequest,
} from "../../../packages/domain/src/execution/execution-port.ts";
import { resolveOrderQuantity } from "../../../packages/domain/src/execution/execution-port.ts";
import { deriveClientOrderId } from "../../../packages/domain/src/execution/client-order-id.ts";
import {
  classifyFill,
  type NormalizedOrderState,
} from "../../../packages/domain/src/execution/fill-accounting.ts";
import type { ExchangeCredential } from "../../exchange-credentials.ts";
import type { RateLimitPool } from "./rate-limit-pool.ts";

/** 交易所返回的订单，归一化之后的形态。各家字段名不同，由适配器负责映射。 */
export type NormalizedOrder = {
  externalOrderId: string | null;
  state: NormalizedOrderState;
  filledQuantity: number;
  averagePrice: number;
  feeAmount: number;
};

export type LiveOrderAdapter = {
  readonly exchange: string;
  placeMarketOrder(input: {
    credentials: ExchangeCredential;
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    clientOrderId: string;
  }): Promise<NormalizedOrder>;
  /**
   * 按 clientOrderId 查单。
   *
   * 这是超时恢复的唯一入口：请求发出去而回应没回来时，我们从未拿到过交易所订单号，
   * 手上只有自己派生的 clientOrderId。适配器**必须**支持按它查询，否则
   * 「那一单到底成没成」只能靠人工去交易所后台核对。
   */
  getOrderByClientOrderId(input: {
    credentials: ExchangeCredential;
    symbol: string;
    clientOrderId: string;
  }): Promise<NormalizedOrder | null>;
};

export type PortfolioExecutionAccount = {
  accountId: string;
  customerId: string;
  exchange: string;
};

export type LiveExecutionDependencies = {
  resolveAccount(portfolioId: string): Promise<PortfolioExecutionAccount | null>;
  loadCredential(input: { accountId: string; customerId: string }): Promise<{ credentials: ExchangeCredential }>;
  adapterFor(exchange: string): LiveOrderAdapter | null;
  rateLimiter: RateLimitPool;
  now(): Date;
  /** 默认读环境变量；注入是为了让单测能同时覆盖开与关两种状态。 */
  liveRoutingEnabled?(): boolean;
};

function defaultLiveRoutingEnabled(): boolean {
  return process.env.LIVE_EXECUTION_ENABLED === "true";
}

function rejectedReceipt(intentId: string, reason: string, executedAt: string): ExecutionReceipt {
  return {
    intentId,
    venue: "live",
    outcome: "rejected",
    filledQuantity: 0,
    averagePrice: 0,
    feeAmount: 0,
    rejectionReason: reason,
    externalOrderId: null,
    executedAt,
  };
}

export function createLiveExecutionPort(deps: LiveExecutionDependencies): ExecutionPort {
  const liveRoutingEnabled = deps.liveRoutingEnabled ?? defaultLiveRoutingEnabled;

  async function executeOne(request: ExecutionRequest): Promise<ExecutionReceipt> {
    const executedAt = deps.now().toISOString();
    const { intent } = request;

    const account = await deps.resolveAccount(request.portfolioId);
    if (!account) return rejectedReceipt(intent.id, "PORTFOLIO_ACCOUNT_NOT_FOUND", executedAt);

    const adapter = deps.adapterFor(account.exchange);
    if (!adapter) return rejectedReceipt(intent.id, "EXCHANGE_ADAPTER_NOT_AVAILABLE", executedAt);

    // 用入场区间中值作为换算参考价。意图本身只给「目标仓位比例」，
    // 换算成数量需要一个价格，而区间是决策当时明确认可的价格范围。
    const referencePrice = (intent.entryPriceRange.min + intent.entryPriceRange.max) / 2;
    const quantity = resolveOrderQuantity(request, referencePrice);
    if (quantity <= 0) return rejectedReceipt(intent.id, "ORDER_QUANTITY_ZERO", executedAt);

    // side 参与派生，于是同一轮同一组合的开仓与平仓是两个不同的 id。
    // 若共用一个，平仓会被交易所当成开仓的重复请求拒掉——客户想离场却离不了。
    const clientOrderId = await deriveClientOrderId({
      decisionRoundId: intent.provenance.decisionRoundId,
      portfolioId: request.portfolioId,
      action: intent.side,
    });

    if (!liveRoutingEnabled()) {
      // 默认路径。不是错误状态，但必须留下一条明确的回执——静默跳过会让上层
      // 以为下单成功了（INV-6）。
      return rejectedReceipt(intent.id, "LIVE_ROUTING_DISABLED", executedAt);
    }

    await deps.rateLimiter.acquire({ exchange: account.exchange, accountId: account.accountId });
    const { credentials } = await deps.loadCredential({
      accountId: account.accountId,
      customerId: account.customerId,
    });

    let order: NormalizedOrder;
    try {
      order = await adapter.placeMarketOrder({
        credentials, symbol: intent.symbol, side: intent.side, quantity, clientOrderId,
      });
    } catch (error) {
      // 下单失败可能是「确实没下成」，也可能是「下成了但回应丢了」。
      // 用我们自己派生的 clientOrderId 去查一次——这正是它存在的理由。
      try {
        const recovered = await adapter.getOrderByClientOrderId({
          credentials, symbol: intent.symbol, clientOrderId,
        });
        if (!recovered) {
          return rejectedReceipt(intent.id,
            `PLACE_FAILED:${error instanceof Error ? error.name : "UNKNOWN"}`, executedAt);
        }
        order = recovered;
      } catch {
        // 查也查不到。**不能当作没下单**——那会导致重试时重复下单。
        // 交给第 4 步的对账任务，并显式标注状态未知（INV-7）。
        return rejectedReceipt(intent.id, "RECONCILE_WAIT", executedAt);
      }
    }

    const classification = classifyFill({
      requestedQuantity: quantity,
      filledQuantity: order.filledQuantity,
      averagePrice: order.averagePrice,
      state: order.state,
    });

    return {
      intentId: intent.id,
      venue: "live",
      outcome: classification.outcome,
      filledQuantity: classification.filledQuantity,
      averagePrice: classification.averagePrice,
      feeAmount: order.feeAmount,
      rejectionReason: classification.rejectionReason,
      externalOrderId: order.externalOrderId,
      executedAt,
    };
  }

  return {
    venue: "live",
    async execute(requests: ExecutionRequest[]): Promise<ExecutionReceipt[]> {
      // 扇出是 N 个独立结果，不是一个事务：单个账户失败不影响其他账户（ADR-0019）。
      // 因此每一条都必须产出回执，一条都不能少——静默丢弃等于客户没跟上这一轮，
      // 而他并不知道。
      const receipts: ExecutionReceipt[] = [];
      for (const request of requests) {
        try {
          receipts.push(await executeOne(request));
        } catch (error) {
          receipts.push(rejectedReceipt(
            request.intent.id,
            `EXECUTION_ERROR:${error instanceof Error ? error.name : "UNKNOWN"}`,
            deps.now().toISOString(),
          ));
        }
      }
      return receipts;
    },
  };
}
