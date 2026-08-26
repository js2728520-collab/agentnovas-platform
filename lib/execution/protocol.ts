/**
 * Web 层与执行服务之间的内网协议。
 *
 * 这个文件**两边都会 import**，因此不得引用任何解密代码——否则 Web 构建又会把
 * 解密逻辑打进去，第 2 步就白做了（架构边界规则第 8 条会抓）。这里只有类型与
 * 常量。
 *
 * 共享密钥（`EXECUTION_SERVICE_SHARED_SECRET`）与凭证加密密钥
 * （`EXCHANGE_CREDENTIAL_ENCRYPTION_KEY`）是两把不同的密钥，做两件不同的事：
 *
 * - 加密密钥回答「密文怎么还原成凭证」。它 + 数据库读权限 = 全部客户的 API Key。
 * - 共享密钥回答「谁有资格向执行服务提出请求」。执行服务是全系统唯一能解密的
 *   地方，如果内网上任何东西都能调它，把加密密钥搬过去就没有意义——攻击者不用
 *   偷密钥，直接让服务替他下单即可。
 *
 * 共享密钥泄露的后果是「能让服务替他操作」，加密密钥泄露的后果是「直接拿走凭证」。
 * 爆炸半径不同，所以必须分开存放、分开轮换。
 */

export const EXECUTION_AUTH_HEADER = "x-riverton-execution-auth";

export type ExecutionRequest =
  | { operation: "verify_exchange_account"; accountId: string; customerId: string }
  | { operation: "emergency_close_okx_demo"; tradeId: string; accountId: string; customerId: string; now: string }
  | {
      operation: "bind_exchange_account";
      customerId: string;
      exchange: string;
      environment: "demo" | "live";
      label: string;
      apiKey: string;
      secretKey: string;
      passphrase?: string;
      canTrade: boolean;
      now: string;
    }
  | {
      /**
       * 下发一条已翻译好的订单意图。
       *
       * Worker 只送「决定做什么」，凭证解密、限流、熔断、对账登记全部发生在执行
       * 服务进程内——Worker 从头到尾不接触任何客户凭证。
       */
      operation: "execute_order_intent";
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
    };

/** 执行服务的回复里**永不包含凭证**。这是这层协议存在的全部意义。 */
export type ExecutionResponse<T> =
  | { ok: true; result: T }
  | { ok: false; code: string; message: string };

export type VerifyExchangeAccountResult = {
  canRead: boolean;
  canTrade: boolean;
  canWithdraw?: boolean;
  permissions?: string[];
  accountMode?: string;
  positionMode?: string;
  verificationMode: "official" | "local-demo";
  exchange: string;
  environment: "demo" | "live";
};

/**
 * 执行服务不可用时必须显式区分，不能当作「验证失败」。
 *
 * 把「我们的服务连不上」显示成「你的交易所账户有问题」会让客户去改一个没坏的
 * 东西——INV-6 要求未达门槛显式标注，不得伪装成已知结论。
 */
export type BindExchangeAccountResult = { accountId: string };

export type ExecuteOrderIntentResult = {
  intentId: string;
  outcome: "filled" | "partial" | "rejected" | "expired";
  filledQuantity: number;
  averagePrice: number;
  feeAmount: number;
  rejectionReason: string | null;
  externalOrderId: string | null;
  executedAt: string;
};

export const EXECUTION_UNAVAILABLE_CODE = "EXECUTION_SERVICE_UNAVAILABLE";
