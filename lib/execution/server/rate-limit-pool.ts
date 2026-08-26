/**
 * 扇出限流池。
 *
 * 判定在域层（`packages/domain/src/execution/rate-limit.ts`），这里只负责两件
 * 基础设施的事：保存每个 (交易所, 账户) 与 (交易所, 全局) 的桶状态，以及真的等到
 * 计划时刻再放行。
 *
 * 之所以拆成两层，是因为「1000 个账户排进 20 次/秒的预算要多久」必须能写单测，
 * 而不用真的等那么久。
 */

import {
  newTokenBucket,
  planTwoLevelDispatch,
  type TokenBucketConfig,
  type TokenBucketState,
} from "../../../packages/domain/src/execution/rate-limit.ts";

export type ExchangeRateLimitConfig = {
  account: TokenBucketConfig;
  global: TokenBucketConfig;
};

/**
 * 各交易所的限流口径不同（权重制、按端点、按 IP），数值从交易所文档取，
 * 不写死在代码里——运维端可调。这里的默认值是保守下限，宁可慢也不要被封 IP。
 */
export const DEFAULT_EXCHANGE_RATE_LIMITS: Record<string, ExchangeRateLimitConfig> = {
  okx: { account: { capacity: 5, refillPerSecond: 5 }, global: { capacity: 30, refillPerSecond: 20 } },
  binance: { account: { capacity: 5, refillPerSecond: 5 }, global: { capacity: 40, refillPerSecond: 20 } },
  bybit: { account: { capacity: 5, refillPerSecond: 5 }, global: { capacity: 30, refillPerSecond: 20 } },
};

/** 未知交易所用最保守的一档，而不是「不限流」。 */
export const FALLBACK_RATE_LIMIT: ExchangeRateLimitConfig = {
  account: { capacity: 2, refillPerSecond: 1 },
  global: { capacity: 5, refillPerSecond: 2 },
};

export type RateLimitPool = {
  /** 等到这一笔可以发出为止。返回实际等待的毫秒数，供观测使用。 */
  acquire(input: { exchange: string; accountId: string }): Promise<number>;
};

export function createRateLimitPool(options: {
  limits?: Record<string, ExchangeRateLimitConfig>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): RateLimitPool {
  const limits = options.limits ?? DEFAULT_EXCHANGE_RATE_LIMITS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const accountBuckets = new Map<string, TokenBucketState>();
  const globalBuckets = new Map<string, TokenBucketState>();

  function configFor(exchange: string): ExchangeRateLimitConfig {
    return limits[exchange.toLowerCase()] ?? FALLBACK_RATE_LIMIT;
  }

  return {
    async acquire({ exchange, accountId }) {
      const config = configFor(exchange);
      const accountKey = `${exchange}:${accountId}`;
      const globalKey = exchange;
      const nowMs = now();

      const state = {
        account: accountBuckets.get(accountKey) ?? newTokenBucket(config.account, nowMs),
        global: globalBuckets.get(globalKey) ?? newTokenBucket(config.global, nowMs),
      };
      const plan = planTwoLevelDispatch(state, config, nowMs);

      // 先把扣费写回去再等待。若等待期间有别的调用进来，它必须看到这一笔已经占了
      // 名额——否则并发调用会各自基于同一份旧状态规划，全部算出「现在就能发」。
      accountBuckets.set(accountKey, plan.nextState.account);
      globalBuckets.set(globalKey, plan.nextState.global);

      const waitMs = Math.max(0, plan.startAtMs - nowMs);
      if (waitMs > 0) await sleep(waitMs);
      return waitMs;
    },
  };
}
