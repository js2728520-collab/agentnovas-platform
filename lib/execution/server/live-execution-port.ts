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
import type { AccountReconciliationState } from "../../../packages/domain/src/execution/reconciliation.ts";
import {
  admitOrder,
  type ActiveKillSwitch,
} from "../../../packages/domain/src/execution/kill-switch.ts";
import {
  resolveLiveRouting,
  type ExecutionProduct,
  type LiveRoutingGrant,
} from "../../../packages/domain/src/execution/live-routing.ts";
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

/**
 * 下单量。**单位是类型的一部分，不是约定。**
 *
 * 曾经这里是一个裸的 `quantity: number`，而现货市价单买卖两边的单位天然不同：
 * 买入按计价货币金额（花多少 USDT），卖出按基础货币数量（卖多少个币）。
 * 编排层算出的是基础币数量，两个适配器却都把它当成计价金额用——
 * 价格 >1 时表现为「买得太少」，价格 <1 时就是**成倍超买**。
 *
 * 裸 number 无法阻止这种错配，判别联合可以：买单没有 baseQuantity 字段可传。
 */
export type MarketOrderSize =
  | { side: "buy"; quoteAmount: number }
  | { side: "sell"; baseQuantity: number };

export type LiveOrderAdapter = {
  readonly exchange: string;
  placeMarketOrder(input: {
    credentials: ExchangeCredential;
    symbol: string;
    size: MarketOrderSize;
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
  /** 该账户绑定的是模拟盘还是实盘。两者分别授权，开通 demo 不等于开通实盘。 */
  environment: "demo" | "live";
};

export type LiveExecutionDependencies = {
  resolveAccount(portfolioId: string): Promise<PortfolioExecutionAccount | null>;
  loadCredential(input: { accountId: string; customerId: string }): Promise<{ credentials: ExchangeCredential }>;
  /**
   * 按 (交易所, 环境) 取适配器。
   *
   * **environment 必须参与选择。** 曾经这里只按交易所取，适配器自己默认 demo：
   * 于是运维正确批准了 live 授权、订单却发往模拟盘端点；而将来把适配器改成 live
   * 时，绑定为 demo 的账户会跟着一起上真实交易所——「demo 与 live 分别授权」
   * 那道闸门会在打开实盘的那一刻反向失效。
   */
  adapterFor(exchange: string, environment: "demo" | "live"): LiveOrderAdapter | null;
  rateLimiter: RateLimitPool;
  now(): Date;
  /** 该账户的对账未决情况。开仓前要问，平仓不问。 */
  loadReconciliationState(accountId: string): Promise<AccountReconciliationState>;
  /** 当前生效的熔断开关。同样只作用于开仓。 */
  loadActiveKillSwitches(): Promise<readonly ActiveKillSwitch[]>;
  /** 已批准的实盘路由授权，按 (交易所, 环境) 逐条灰度。默认空 = 全关。 */
  loadLiveRoutingGrants(): Promise<readonly LiveRoutingGrant[]>;
  /** 本次执行的标的。永续在任何配置下都不可路由。 */
  executionProduct: ExecutionProduct;
  /** 登记一笔待对账。下单响应不是事实，必须查单确认（ADR-0019 第 4 步）。 */
  enqueueReconciliation(input: {
    clientOrderId: string;
    accountId: string;
    customerId: string;
    exchange: string;
    symbol: string;
    requestedQuantity: number;
    decisionRoundId: string;
    portfolioId: string;
    intentId: string;
    externalOrderId: string | null;
  }): Promise<void>;
};

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
  async function executeOne(request: ExecutionRequest): Promise<ExecutionReceipt> {
    const executedAt = deps.now().toISOString();
    const { intent } = request;

    const account = await deps.resolveAccount(request.portfolioId);
    if (!account) return rejectedReceipt(intent.id, "PORTFOLIO_ACCOUNT_NOT_FOUND", executedAt);

    const adapter = deps.adapterFor(account.exchange, account.environment);
    if (!adapter) return rejectedReceipt(intent.id, "EXCHANGE_ADAPTER_NOT_AVAILABLE", executedAt);

    // 用入场区间中值作为换算参考价。意图本身只给「目标仓位比例」，
    // 换算成数量需要一个价格，而区间是决策当时明确认可的价格范围。
    const referencePrice = (intent.entryPriceRange.min + intent.entryPriceRange.max) / 2;
    // 基础币数量。买单不直接用它下单（见下），但对账要拿它当请求量。
    const quantity = resolveOrderQuantity(request, referencePrice);
    if (quantity <= 0) return rejectedReceipt(intent.id, "ORDER_QUANTITY_ZERO", executedAt);

    // 买入按计价货币金额，卖出按基础货币数量——现货市价单两边的单位天然不同。
    // 把它做成判别联合而不是一个裸 number，是因为这里曾经把基础币数量当成计价金额
    // 传了下去：价格 >1 时买得太少，价格 <1 时成倍超买。
    const size: MarketOrderSize = intent.side === "buy"
      ? { side: "buy", quoteAmount: quantity * referencePrice }
      : { side: "sell", baseQuantity: quantity };

    // side 参与派生，于是同一轮同一组合的开仓与平仓是两个不同的 id。
    // 若共用一个，平仓会被交易所当成开仓的重复请求拒掉——客户想离场却离不了。
    const clientOrderId = await deriveClientOrderId({
      decisionRoundId: intent.provenance.decisionRoundId,
      portfolioId: request.portfolioId,
      action: intent.side,
    });

    // 熔断与对账两道闸门。判定全在 admitOrder 里，包括「平仓永不被挡」——
    // 那条规则只允许存在于一个地方，分散在两处迟早有一处漏掉，而漏掉的后果是
    // 客户在事故中离不了场，恰恰是熔断本该保护他免于遭遇的处境（INV-7）。
    //
    // 卖出时不查这两张表：既然结论恒为放行，多两次查询只是在离场路径上增加故障点。
    if (intent.side === "buy") {
      const [reconciliation, killSwitches] = await Promise.all([
        deps.loadReconciliationState(account.accountId),
        deps.loadActiveKillSwitches(),
      ]);
      const admission = admitOrder({
        side: intent.side,
        symbol: intent.symbol,
        context: {
          exchange: account.exchange,
          accountId: account.accountId,
          strategyCode: intent.provenance.strategyCode,
        },
        killSwitches,
        reconciliation,
      });
      if (!admission.allowed) {
        return rejectedReceipt(intent.id, admission.reason ?? "ORDER_NOT_ADMITTED", executedAt);
      }
    }

    // 实盘路由按 (交易所, 环境) 逐条授权，默认全关；永续在任何配置下都不可路由。
    // 拒绝时必须留下明确回执——静默跳过会让上层以为下单成功了（INV-6）。
    const routing = resolveLiveRouting({
      exchange: account.exchange,
      environment: account.environment,
      product: deps.executionProduct,
      grants: await deps.loadLiveRoutingGrants(),
      side: intent.side,
    });
    if (!routing.allowed) {
      return rejectedReceipt(intent.id, routing.reason ?? "LIVE_ROUTING_NOT_GRANTED", executedAt);
    }

    await deps.rateLimiter.acquire({ exchange: account.exchange, accountId: account.accountId });
    const { credentials } = await deps.loadCredential({
      accountId: account.accountId,
      customerId: account.customerId,
    });

    let order: NormalizedOrder;
    try {
      order = await adapter.placeMarketOrder({
        credentials, symbol: intent.symbol, size, clientOrderId,
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
        //
        // 必须在这里登记待对账：一个只出现在回执文字里的 RECONCILE_WAIT 没有任何
        // 作用，没人会去查它。登记之后对账任务才会反复查单，最终结案或升级人工，
        // 并在此期间挡住该账户/该品种的新开仓（INV-7）。
        await deps.enqueueReconciliation({
          clientOrderId,
          accountId: account.accountId,
          customerId: account.customerId,
          exchange: account.exchange,
          symbol: intent.symbol,
          requestedQuantity: quantity,
          decisionRoundId: intent.provenance.decisionRoundId,
          portfolioId: request.portfolioId,
          intentId: intent.id,
          externalOrderId: null,
        });
        return rejectedReceipt(intent.id, "RECONCILE_WAIT", executedAt);
      }
    }

    // 先登记待对账，再分类。即使这一刻看起来是终态，下单响应也不是事实——
    // 市价单可能在响应之后才成交，回执要以查单为准。登记是幂等的
    // （client_order_id 唯一），重复登记不会产生第二条。
    await deps.enqueueReconciliation({
      clientOrderId,
      accountId: account.accountId,
      customerId: account.customerId,
      exchange: account.exchange,
      symbol: intent.symbol,
      requestedQuantity: quantity,
      decisionRoundId: intent.provenance.decisionRoundId,
      portfolioId: request.portfolioId,
      intentId: intent.id,
      externalOrderId: order.externalOrderId,
    });

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
