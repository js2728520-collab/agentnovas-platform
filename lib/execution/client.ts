/**
 * Web 层调用执行服务的客户端。
 *
 * **这个文件是 Web 层唯一被允许的执行入口。** 它只发 HTTP，不 import 任何解密
 * 代码——这正是第 2 步的全部意义：Web 构建里不再包含还原客户凭证的能力，
 * 公网盒子被攻破也拿不到交易权限（ADR-0019）。
 *
 * 没有「服务不可用就本地跑」的降级路径。那种降级会把解密代码重新打进 Web 构建，
 * 等于这一步没做。宁可报错。
 */

import {
  EXECUTION_AUTH_HEADER,
  EXECUTION_UNAVAILABLE_CODE,
  type ExecutionRequest,
  type ExecutionResponse,
  type BindExchangeAccountResult,
  type ExecuteOrderIntentResult,
  type VerifyExchangeAccountResult,
} from "./protocol.ts";

export class ExecutionServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionServiceError";
    this.code = code;
  }

  /** 是否属于「我们的服务不可用」而非「你的账户有问题」。 */
  get isUnavailable(): boolean {
    return this.code === EXECUTION_UNAVAILABLE_CODE;
  }
}

/** 单次调用上限。交易所自身的超时更短，这里只兜底防止请求悬挂占住 Web 进程。 */
const REQUEST_TIMEOUT_MS = 30_000;

async function callExecutionService<T>(request: ExecutionRequest): Promise<T> {
  const baseUrl = process.env.EXECUTION_SERVICE_URL;
  const secret = process.env.EXECUTION_SERVICE_SHARED_SECRET;
  if (!baseUrl || !secret) {
    throw new ExecutionServiceError(
      EXECUTION_UNAVAILABLE_CODE,
      "EXECUTION_SERVICE_URL / EXECUTION_SERVICE_SHARED_SECRET 未配置",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", [EXECUTION_AUTH_HEADER]: secret },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // 连不上 / 超时 —— 是我们的问题，必须与「交易所拒绝」区分开（INV-6）。
    throw new ExecutionServiceError(
      EXECUTION_UNAVAILABLE_CODE,
      `执行服务不可达：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    // 内网鉴权失败是部署配置问题，不是客户的问题。
    throw new ExecutionServiceError(EXECUTION_UNAVAILABLE_CODE, "执行服务拒绝了内网鉴权");
  }
  if (!response.ok && response.status >= 500) {
    throw new ExecutionServiceError(EXECUTION_UNAVAILABLE_CODE, `执行服务返回 ${response.status}`);
  }

  const payload = await response.json().catch(() => null) as ExecutionResponse<T> | null;
  if (!payload) throw new ExecutionServiceError(EXECUTION_UNAVAILABLE_CODE, "执行服务返回了无法解析的响应");
  if (!payload.ok) throw new ExecutionServiceError(payload.code, payload.message);
  return payload.result;
}

export function verifyExchangeAccount(input: {
  accountId: string;
  customerId: string;
}): Promise<VerifyExchangeAccountResult> {
  return callExecutionService<VerifyExchangeAccountResult>({
    operation: "verify_exchange_account",
    accountId: input.accountId,
    customerId: input.customerId,
  });
}

export type EmergencyCloseResult = {
  tradeId: string;
  symbol: string;
  status: "closed" | "pending" | "unsupported" | "failed";
  message: string;
};

export function closeOkxDemoTrade(input: {
  tradeId: string;
  accountId: string;
  customerId: string;
  now: string;
}): Promise<EmergencyCloseResult> {
  return callExecutionService<EmergencyCloseResult>({ operation: "emergency_close_okx_demo", ...input });
}

/**
 * 绑定交易所账户。
 *
 * 明文凭证经 Web 进程转发一次，加密与落库都发生在执行服务——Web 层因此不再需要
 * 凭证加密密钥。对称加密下「能加密就能解密」，把加密留在 Web 层等于把密钥留在
 * Web 层（ADR-0019 第 2 步）。
 */
export function bindExchangeAccount(input: {
  customerId: string;
  exchange: string;
  environment: "demo" | "live";
  label: string;
  apiKey: string;
  secretKey: string;
  passphrase?: string;
  canTrade: boolean;
  now: string;
}): Promise<BindExchangeAccountResult> {
  return callExecutionService<BindExchangeAccountResult>({ operation: "bind_exchange_account", ...input });
}

/**
 * 下发一条订单意图。Worker 用它把决策接到真实执行上。
 *
 * 意图本身已经在域层翻译并校验过（intent-translation.ts）；这里只负责送过去。
 */
export function executeOrderIntent(input: {
  deploymentId: string;
  customerId: string;
  accountId: string;
  portfolioId: string;
  intent: unknown;
  availableCapital: number;
  capitalCapRatio: number;
  executionProduct: "spot_usdt" | "usdt_perpetual";
  runtimeCycleId: string | null;
  traceId: string | null;
}): Promise<ExecuteOrderIntentResult> {
  return callExecutionService<ExecuteOrderIntentResult>({ operation: "execute_order_intent", ...input });
}
