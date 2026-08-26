/**
 * OKX 的 LiveOrderAdapter。
 *
 * 只做一件事：把 OKX 的字段与状态名映射成执行层的归一化形态。编排（幂等、限流、
 * 分类、对账）在上层，与交易所无关。新增交易所时只写一个这样的文件。
 *
 * OKX 的模拟盘与实盘是同一套 REST API，区别只有 `x-simulated-trading: 1` 这个
 * 请求头。所以这里不需要两份实现，只需要把环境显式传下去。
 *
 * 默认 demo，且默认值只在一处（okx-demo-execution 的请求层）。一个默认走实盘的
 * 适配器等于把 execution_live_routing 的灰度闸门绕过去了——实盘要靠那份显式授权
 * 打开，不靠这里的默认值。
 *
 * 反过来同样危险：把 live 账户静默发到模拟盘端点，客户会以为自己有实盘仓位，
 * 而交易所里是模拟仓位。两个方向都由 (exchange, environment) 成对注册来防止。
 */

import { getOkxDemoOrder, okxFeeInUsdt, placeOkxDemoMarketOrder, type OkxDemoOrder } from "../../okx-demo-execution.ts";
import type { NormalizedOrderState } from "../../../packages/domain/src/execution/fill-accounting.ts";
import type { LiveOrderAdapter, NormalizedOrder } from "./live-execution-port.ts";

/**
 * OKX 状态名到归一化状态的映射。
 *
 * 未知状态映射成 `live` 而不是 `rejected`：把一个我们没见过的状态当成「被拒」，
 * 会让上层结案并允许重试——如果那个状态其实是「已成交」，就变成重复下单。
 * 当成「还在挂着」最坏是多查几次，然后由对账任务升级人工（INV-7）。
 */
export function normalizeOkxState(state: string): NormalizedOrderState {
  switch (state) {
    case "filled": return "filled";
    case "partially_filled": return "partially_filled";
    case "canceled": return "canceled";
    case "mmp_canceled": return "canceled";
    case "rejected": return "rejected";
    case "live":
    case "submitted":
    default: return "live";
  }
}

function toNormalizedOrder(order: OkxDemoOrder): NormalizedOrder {
  return {
    externalOrderId: order.orderId || null,
    state: normalizeOkxState(order.state),
    filledQuantity: order.filledQuantity,
    averagePrice: order.averagePrice,
    feeAmount: okxFeeInUsdt(order),
  };
}

export function createOkxOrderAdapter(options: { environment?: "demo" | "live" } = {}): LiveOrderAdapter {
  const environment = options.environment ?? "demo";
  return {
    exchange: "okx",
    async placeMarketOrder(input) {
      // 单位由 MarketOrderSize 的判别联合保证，这里只做直译，不做任何换算。
      const order = await placeOkxDemoMarketOrder({
        credentials: input.credentials,
        symbol: input.symbol,
        side: input.size.side,
        ...(input.size.side === "buy"
          ? { notionalUsdt: input.size.quoteAmount }
          : { quantity: input.size.baseQuantity }),
        clientOrderId: input.clientOrderId,
        environment,
      });
      return toNormalizedOrder(order);
    },
    async getOrderByClientOrderId(input) {
      try {
        return toNormalizedOrder(await getOkxDemoOrder({
          credentials: input.credentials,
          symbol: input.symbol,
          clientOrderId: input.clientOrderId,
          environment,
        }));
      } catch (error) {
        // 「查不到该订单」是一个明确的答案（返回 null），其它错误必须继续往上抛——
        // 把网络故障也当成「订单不存在」会让对账把真实成交判成未下单。
        if (error instanceof Error && /查询不到该订单/.test(error.message)) return null;
        throw error;
      }
    },
  };
}
