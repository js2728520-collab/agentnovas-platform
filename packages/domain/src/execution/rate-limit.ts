/**
 * 扇出限流的判定。
 *
 * 一轮决策会扇出到全部订阅该策略卡的客户账户，每一次都是真实的交易所 API 调用。
 * 各交易所的限流口径不同（权重制、按端点、按 IP），超出后轻则拒绝，重则封禁 IP——
 * 那会让**所有**客户在这一轮都跟不上。
 *
 * 两条设计上的硬规则：
 *
 * **一、排队而不是丢弃。** 本模块的输出是「这一笔什么时候可以发」，永远不是
 * 「这一笔不发了」。丢弃等于客户没跟上这一轮，而他并不知道（ADR-0019）。
 *
 * **二、这里只算时间，不睡觉。** 计时器属于基础设施。判定是纯函数才能对
 * 「1000 个账户排进 20 次/秒的预算要多久」写单测，而不用真的等那么久。
 */

export type TokenBucketConfig = {
  /** 桶容量：允许的瞬时突发量。 */
  capacity: number;
  /** 每秒补充的令牌数，即稳态速率。 */
  refillPerSecond: number;
};

export type TokenBucketState = {
  tokens: number;
  updatedAtMs: number;
};

function assertConfig(config: TokenBucketConfig, label: string): void {
  if (!Number.isFinite(config.capacity) || config.capacity <= 0) {
    throw new Error(`RATE_LIMIT_CONFIG_INVALID:${label}.capacity`);
  }
  // refillPerSecond <= 0 会让桶永远不再补充，排队时间变成无穷大。
  // 与其算出一个 Infinity 让调用方莫名其妙地永远等下去，不如在配置处就报错——
  // 限流配置由运维在后台可调，配错的可能性是真实存在的。
  if (!Number.isFinite(config.refillPerSecond) || config.refillPerSecond <= 0) {
    throw new Error(`RATE_LIMIT_CONFIG_INVALID:${label}.refillPerSecond`);
  }
}

export function newTokenBucket(config: TokenBucketConfig, nowMs: number): TokenBucketState {
  assertConfig(config, "bucket");
  return { tokens: config.capacity, updatedAtMs: nowMs };
}

/** 把状态推进到 nowMs：按流逝时间补充令牌，上限为容量。 */
export function refillTokenBucket(
  state: TokenBucketState,
  config: TokenBucketConfig,
  nowMs: number,
): TokenBucketState {
  assertConfig(config, "bucket");
  // 时间倒流不应凭空造出令牌，**也不应把桶的时间线拨回去**。
  //
  // 后半句是扇出场景的关键：一轮决策会在同一个 now 上一次性规划上千笔下单，
  // 每一笔都把桶推向未来。若第 N 笔仍以调用方的 now 为原点，它算出的等待时间会
  // 从一个早已过去的时刻起算，于是所有排队都被压缩到前面——限流恰好在
  // 「一次规划上千笔」这个它唯一存在的理由上失效。
  const effectiveNowMs = Math.max(nowMs, state.updatedAtMs);
  const elapsedMs = effectiveNowMs - state.updatedAtMs;
  const refilled = state.tokens + (elapsedMs / 1000) * config.refillPerSecond;
  return { tokens: Math.min(config.capacity, refilled), updatedAtMs: effectiveNowMs };
}

/** 单个桶：这一笔最早可发的时刻，以及扣费之后的桶状态。 */
export function planTokenBucketDispatch(
  state: TokenBucketState,
  config: TokenBucketConfig,
  nowMs: number,
  cost = 1,
): { startAtMs: number; nextState: TokenBucketState } {
  assertConfig(config, "bucket");
  if (!Number.isFinite(cost) || cost <= 0) throw new Error("RATE_LIMIT_COST_INVALID");
  // 单笔开销超过桶容量则永远攒不够，必须报错而不是无限等待。
  if (cost > config.capacity) throw new Error("RATE_LIMIT_COST_EXCEEDS_CAPACITY");

  const refilled = refillTokenBucket(state, config, nowMs);
  // 以桶自己的时间线为准，不是调用方的 now（见 refillTokenBucket 的说明）。
  const effectiveNowMs = refilled.updatedAtMs;
  if (refilled.tokens >= cost) {
    return {
      startAtMs: effectiveNowMs,
      nextState: { tokens: refilled.tokens - cost, updatedAtMs: effectiveNowMs },
    };
  }
  const deficit = cost - refilled.tokens;
  const waitMs = Math.ceil((deficit / config.refillPerSecond) * 1000);
  const startAtMs = effectiveNowMs + waitMs;
  // 扣费记在实际发出的时刻，不是现在——否则桶的时间线会跑到调用的前面。
  const atStart = refillTokenBucket(refilled, config, startAtMs);
  return { startAtMs, nextState: { tokens: Math.max(0, atStart.tokens - cost), updatedAtMs: startAtMs } };
}

export type TwoLevelBucketState = {
  /** (交易所, 账户) 级：保护单个客户的账户不被自己的策略打爆。 */
  account: TokenBucketState;
  /** (交易所, 全局) 级：保护整个平台在该交易所的配额与 IP。 */
  global: TokenBucketState;
};

export type TwoLevelBucketConfig = {
  account: TokenBucketConfig;
  global: TokenBucketConfig;
};

/**
 * 两级令牌桶。
 *
 * 关键在于**两级必须在同一时刻扣费**：先取两级各自的最早可发时刻，取较晚者作为
 * 实际发出时刻，再让两级都按那个时刻扣。若各扣各的，全局桶会按一个比真实发出
 * 时间更早的时刻记账，于是它以为自己还有余量，实际已经超发——限流在最需要它的
 * 高并发时刻失效。
 */
export function planTwoLevelDispatch(
  state: TwoLevelBucketState,
  config: TwoLevelBucketConfig,
  nowMs: number,
  cost = 1,
): { startAtMs: number; nextState: TwoLevelBucketState } {
  const accountPlan = planTokenBucketDispatch(state.account, config.account, nowMs, cost);
  const globalPlan = planTokenBucketDispatch(state.global, config.global, nowMs, cost);
  const startAtMs = Math.max(accountPlan.startAtMs, globalPlan.startAtMs);
  if (startAtMs === accountPlan.startAtMs && startAtMs === globalPlan.startAtMs) {
    return { startAtMs, nextState: { account: accountPlan.nextState, global: globalPlan.nextState } };
  }
  // 有一级需要等：两级都按最终时刻重算，保证账记在同一个时间点上。
  return {
    startAtMs,
    nextState: {
      account: planTokenBucketDispatch(state.account, config.account, startAtMs, cost).nextState,
      global: planTokenBucketDispatch(state.global, config.global, startAtMs, cost).nextState,
    },
  };
}
