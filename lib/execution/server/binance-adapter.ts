/**
 * Binance 的 LiveOrderAdapter。
 *
 * 与 OKX 那份结构一致：只做字段与状态名的归一化，编排（幂等、限流、分类、对账）
 * 在上层，与交易所无关。新增交易所就是再写一个这样的文件。
 */

import {
  BinanceOrderNotFoundError,
  getBinanceSpotOrder,
  placeBinanceSpotMarketOrder,
  type BinanceSpotOrder,
} from "../../binance-spot-execution.ts";
import type { NormalizedOrderState } from "../../../packages/domain/src/execution/fill-accounting.ts";
import type { LiveOrderAdapter, NormalizedOrder } from "./live-execution-port.ts";

/**
 * Binance 订单状态到归一化状态的映射。
 *
 * 与 OKX 适配器同一条原则：**未知状态映射成 `live`，不是 `rejected`。**
 * 把没见过的状态当成被拒会让上层结案并允许重试；如果那个状态其实是已成交，
 * 就变成重复下单。当成还在挂着最坏是多查几次，再由对账升级人工（INV-7）。
 *
 * `EXPIRED` 在 Binance 现货市价单里的含义是「未成交部分被撤销」——它是终态，
 * 归到 canceled；已成交的部分由 executedQty 如实带出，仍会被判成 partial。
 */
export function normalizeBinanceStatus(status: string): NormalizedOrderState {
  switch (status.toUpperCase()) {
    case "FILLED": return "filled";
    case "PARTIALLY_FILLED": return "partially_filled";
    case "CANCELED":
    case "PENDING_CANCEL":
    case "EXPIRED":
    case "EXPIRED_IN_MATCH":
      return "canceled";
    case "REJECTED": return "rejected";
    case "NEW":
    default: return "live";
  }
}

function toNormalizedOrder(order: BinanceSpotOrder): NormalizedOrder {
  return {
    externalOrderId: order.orderId || null,
    state: normalizeBinanceStatus(order.status),
    filledQuantity: order.filledQuantity,
    averagePrice: order.averagePrice,
    feeAmount: order.feeUsdt,
  };
}

export function createBinanceOrderAdapter(options: {
  environment?: "demo" | "live";
  /** 注入用于测试；生产走全局 fetch。与仓库其它适配器的约定一致。 */
  fetchImpl?: typeof fetch;
} = {}): LiveOrderAdapter {
  // 默认 demo。实盘要靠 execution_live_routing 的显式授权，不靠这里的默认值——
  // 一个默认为 live 的适配器等于把第 6 步的闸门绕过去了。
  const environment = options.environment ?? "demo";
  return {
    exchange: "binance",
    async placeMarketOrder(input) {
      return toNormalizedOrder(await placeBinanceSpotMarketOrder({
        credentials: input.credentials,
        environment,
        symbol: input.symbol,
        side: input.side,
        quantity: input.quantity,
        clientOrderId: input.clientOrderId,
        fetchImpl: options.fetchImpl,
      }));
    },
    async getOrderByClientOrderId(input) {
      try {
        return toNormalizedOrder(await getBinanceSpotOrder({
          credentials: input.credentials,
          environment,
          symbol: input.symbol,
          clientOrderId: input.clientOrderId,
          fetchImpl: options.fetchImpl,
        }));
      } catch (error) {
        // 只有明确的「订单不存在」返回 null；其它错误继续抛，交给对账状态机。
        if (error instanceof BinanceOrderNotFoundError) return null;
        throw error;
      }
    },
  };
}
