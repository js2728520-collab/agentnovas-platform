/**
 * OKX 的 LiveOrderAdapter。
 *
 * 只做一件事：把 OKX 的字段与状态名映射成执行层的归一化形态。编排（幂等、限流、
 * 分类、对账）在上层，与交易所无关。新增交易所时只写一个这样的文件。
 *
 * 目前接的是 OKX 的模拟盘端点。实盘路由由 LIVE_EXECUTION_ENABLED 控制，默认关闭
 * （ADR-0019 第 6 步才逐个灰度）。
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

export function createOkxOrderAdapter(): LiveOrderAdapter {
  return {
    exchange: "okx",
    async placeMarketOrder(input) {
      const order = await placeOkxDemoMarketOrder({
        credentials: input.credentials,
        symbol: input.symbol,
        side: input.side,
        // 买入按计价货币金额下单，卖出按基础货币数量——OKX 现货市价单的口径。
        ...(input.side === "buy" ? { notionalUsdt: input.quantity } : { quantity: input.quantity }),
        clientOrderId: input.clientOrderId,
      });
      return toNormalizedOrder(order);
    },
    async getOrderByClientOrderId(input) {
      try {
        return toNormalizedOrder(await getOkxDemoOrder({
          credentials: input.credentials,
          symbol: input.symbol,
          clientOrderId: input.clientOrderId,
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
