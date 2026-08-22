/**
 * 执行服务的请求分发。
 *
 * **这个文件及其所在目录只在执行服务进程里运行，永远不进 Web 构建。**
 * 架构边界规则第 8 条强制：app/ 与 apps/ 不得引用 lib/execution/server/ 下的任何
 * 模块。Web 层只能通过 lib/execution/client.ts 发内网请求。
 */

import { timingSafeEqual } from "node:crypto";

import { EXECUTION_AUTH_HEADER, type ExecutionRequest } from "../protocol.ts";
import { bindExchangeAccount } from "./account-binding.ts";
import { closeOkxDemoTradeById } from "./emergency-close.ts";
import { verifyExchangeAccount } from "./exchange-account-verification.ts";

export async function dispatchExecutionRequest(request: ExecutionRequest): Promise<unknown> {
  switch (request.operation) {
    case "verify_exchange_account":
      return verifyExchangeAccount({ accountId: request.accountId, customerId: request.customerId });
    case "bind_exchange_account":
      return bindExchangeAccount({
        customerId: request.customerId,
        exchange: request.exchange,
        environment: request.environment,
        label: request.label,
        apiKey: request.apiKey,
        secretKey: request.secretKey,
        passphrase: request.passphrase,
        canTrade: request.canTrade,
        now: request.now,
      });
    case "emergency_close_okx_demo":
      return closeOkxDemoTradeById({
        tradeId: request.tradeId,
        accountId: request.accountId,
        customerId: request.customerId,
        now: request.now,
      });
    default: {
      // 穷尽性检查：协议里新增 operation 而这里忘了处理时，编译期就报错。
      const unreachable: never = request;
      throw new Error(`UNKNOWN_EXECUTION_OPERATION:${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * 共享密钥校验。
 *
 * 用等长时间比较，不用 `===`。字符串比较会在第一个不同的字节处返回，攻击者可以
 * 用响应时间逐字节猜出密钥——这类攻击在内网同样成立。
 *
 * 密钥缺失时**拒绝启动**而不是放行：一个「没配密钥就不鉴权」的服务，在部署漏配
 * 时会静默变成任何人都能调用的下单接口。
 */
export function assertExecutionSecretConfigured(secret: string | undefined): string {
  if (!secret || secret.length < 32) {
    throw new Error("EXECUTION_SERVICE_SHARED_SECRET 缺失或短于 32 字符，执行服务拒绝启动");
  }
  return secret;
}

export function isAuthorizedExecutionRequest(headerValue: string | undefined, secret: string): boolean {
  if (!headerValue) return false;
  const provided = Buffer.from(headerValue);
  const expected = Buffer.from(secret);
  // timingSafeEqual 要求等长，长度不同直接判否——长度本身不是机密。
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * 允许原样回传给 Web 层的错误身份。
 *
 * 其余一律折叠成 INTERNAL_ERROR。第一次跑通时这里直接回传了 error.message，
 * 而 Drizzle 的失败消息里带着完整 SQL 与参数——等于把库表结构和客户/账户 id
 * 通过一个面向公网进程的接口吐了出去。错误消息属于对外表面，要显式列白名单。
 */
const PUBLIC_ERROR_CODES = new Set([
  "EXCHANGE_ACCOUNT_NOT_FOUND",
  "EXCHANGE_ACCOUNT_HAS_WITHDRAWAL_AUTHORITY",
  "UNKNOWN_EXECUTION_OPERATION",
]);

export function toPublicExecutionError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(":")[0]?.trim() ?? "";
  if (PUBLIC_ERROR_CODES.has(code)) return { code, message: code };
  return { code: "INTERNAL_ERROR", message: "执行服务内部错误" };
}

export { EXECUTION_AUTH_HEADER };
