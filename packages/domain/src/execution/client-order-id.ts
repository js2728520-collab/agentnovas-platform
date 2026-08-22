/**
 * 幂等下单标识。
 *
 * 真实下单最危险的失败不是「被拒绝」，而是**超时**：请求发出去了，回应没回来，
 * 平台不知道这单到底下没下。此时重试可能导致重复下单，不重试可能漏掉这一轮。
 *
 * 解法是让交易所替我们判重：`clientOrderId` 由
 * `(decisionRoundId, portfolioId, action)` 确定性派生，重试必然落在同一个 id 上，
 * 交易所自身会拒绝重复。于是「不知道下没下」从必须人工核对变成可自动恢复
 * （ADR-0019）。
 *
 * **因此这里绝不能掺入时间戳、随机数或重试次数。** 任何让两次重试产生不同 id 的
 * 东西都会把这层保护变成它的反面——重复下单。这是本文件唯一真正的规则。
 */

import { canonicalJsonSha256 } from "../canonical-hash.ts";

/**
 * 各交易所对该字段的约束取交集：OKX clOrdId 允许字母数字、最长 32；
 * Binance newClientOrderId 最长 36；Bybit orderLinkId 最长 36。
 * 取 32 且只用字母数字，一套 id 三家都能用。
 */
export const CLIENT_ORDER_ID_MAX_LENGTH = 32;
export const CLIENT_ORDER_ID_PATTERN = /^[A-Z0-9]{1,32}$/;

/** 前缀让运营在交易所后台一眼认出这是平台下的单。 */
const PREFIX = "RV";

export type ClientOrderIdInput = {
  decisionRoundId: string;
  portfolioId: string;
  /** 该组合在这一轮里要做的事，例如 "entry" / "exit"。同轮同组合的不同动作必须不同 id。 */
  action: string;
};

function assertNonEmpty(value: string, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`CLIENT_ORDER_ID_INPUT_INVALID:${field}`);
  return trimmed;
}

export async function deriveClientOrderId(input: ClientOrderIdInput): Promise<string> {
  // 三个字段都必填。少任何一个都会让不同的下单共用同一个 id——那不是幂等，
  // 是把两笔不同的单合并成一笔。
  const digest = await canonicalJsonSha256({
    action: assertNonEmpty(input.action, "action"),
    decisionRoundId: assertNonEmpty(input.decisionRoundId, "decisionRoundId"),
    portfolioId: assertNonEmpty(input.portfolioId, "portfolioId"),
  });
  // base36 让 256 位摘要压进 30 个字母数字字符（约 155 位），足够避免碰撞，
  // 又不触碰任何交易所的字符集限制。
  const encoded = BigInt(`0x${digest}`).toString(36).toUpperCase();
  const body = encoded.padStart(CLIENT_ORDER_ID_MAX_LENGTH - PREFIX.length, "0")
    .slice(0, CLIENT_ORDER_ID_MAX_LENGTH - PREFIX.length);
  return `${PREFIX}${body}`;
}
