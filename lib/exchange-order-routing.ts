import { EXCHANGE_ADAPTER_STATUS } from "@/lib/exchange-adapters";
import { getExchangeCapability, normalizeExchange } from "@/lib/exchange-capabilities";
import type { ExchangeEnvironment } from "@/lib/exchange-adapters";
import { getExchangeOrderAdapterSummary } from "@/lib/exchange-order-adapters";

export type ExchangeOrderOperation = "place" | "cancel" | "fills" | "positions";

export type ExchangeOrderRoutingStatus = {
  exchange: string;
  environment: ExchangeEnvironment;
  ready: boolean;
  supportedOperations: ExchangeOrderOperation[];
  code?: "EXCHANGE_ORDER_ROUTING_NOT_READY" | "EXCHANGE_LIVE_DISABLED" | "EXCHANGE_NOT_SUPPORTED";
  reason: string;
  adapterStatus: (typeof EXCHANGE_ADAPTER_STATUS)[number] | null;
  adapter: ReturnType<typeof getExchangeOrderAdapterSummary>;
};

const ALL_ORDER_OPERATIONS: ExchangeOrderOperation[] = ["place", "cancel", "fills", "positions"];

/**
 * A credential check is intentionally not treated as an order connector.
 * Every venue must pass its own sandbox tests for order placement, cancel,
 * fill reconciliation and position reconciliation before this returns ready.
 */
export function getExchangeOrderRoutingStatus(
  exchange: string,
  environment: ExchangeEnvironment,
): ExchangeOrderRoutingStatus {
  const key = normalizeExchange(exchange);
  const capability = getExchangeCapability(key);
  const adapterStatus = EXCHANGE_ADAPTER_STATUS.find((item) => item.key === key) || null;

  if (!capability || !adapterStatus) {
    return {
      exchange: key,
      environment,
      ready: false,
      supportedOperations: [],
      code: "EXCHANGE_NOT_SUPPORTED",
      reason: "该交易所尚未登记订单适配器，系统不会发送订单。",
      adapterStatus: null,
      adapter: null,
    };
  }

  if (environment === "live") {
    return {
      exchange: key,
      environment,
      ready: false,
      supportedOperations: [],
      code: "EXCHANGE_LIVE_DISABLED",
      reason: "实盘订单路由尚未通过沙盒、回滚和人工审批验证，当前只允许保存凭证与权限检测。",
      adapterStatus,
      adapter: getExchangeOrderAdapterSummary(key, environment),
    };
  }

  if (!adapterStatus.orderRoutingReady) {
    return {
      exchange: key,
      environment,
      ready: false,
      supportedOperations: [],
      code: "EXCHANGE_ORDER_ROUTING_NOT_READY",
      reason: "官方鉴权已接入；下单、撤单、成交同步和持仓同步仍待该交易所沙盒验证。",
      adapterStatus,
      adapter: getExchangeOrderAdapterSummary(key, environment),
    };
  }

  return {
    exchange: key,
    environment,
    ready: true,
    supportedOperations: ALL_ORDER_OPERATIONS,
    reason: "该环境的订单链路已登记，可继续通过硬风控和交易开关。",
    adapterStatus,
    adapter: getExchangeOrderAdapterSummary(key, environment),
  };
}

export function orderOperationLabel(operation: ExchangeOrderOperation) {
  return ({
    place: "下单",
    cancel: "撤单",
    fills: "成交同步",
    positions: "持仓同步",
  } satisfies Record<ExchangeOrderOperation, string>)[operation];
}
