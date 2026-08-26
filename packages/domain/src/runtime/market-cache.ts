/**
 * 行情复用策略。
 *
 * 官方现货是「每个 (客户, 策略卡) 一个部署」，每个部署自己跑决策周期。5,000 会员
 * × 3 张卡 = 15,000 个部署，而三张卡合计只有 **6 种 (品种, 周期) 组合**——
 * 也就是说同一份 K 线会被重复拉取 2,500 次。打公开行情接口必然触发限流。
 *
 * 这里定义「一份行情什么时候还能用」。判定是纯函数，可脱网单测；缓存本身在
 * lib/strategy-runtime-worker.ts，因为它是进程状态。
 *
 * 复用是安全的：适配器返回的是最新的 N 根 K 线，各部署再用
 * selectCycleCandle 从中挑自己那一根。不同部署的 lastCandleCloseTime 不同，
 * 但它们要的候选集合是同一个。
 */

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

/** 未知周期返回 null——调用方应当据此放弃复用，而不是猜一个时长（INV-7）。 */
export function timeframeMilliseconds(timeframe: string): number | null {
  return TIMEFRAME_MS[timeframe] ?? null;
}

export function marketCacheKey(symbol: string, timeframe: string, limit: number) {
  return `${symbol}:${timeframe}:${limit}`;
}

/**
 * 缓存条目是否还在同一根 K 线周期内。
 *
 * 用「归属的 K 线桶」判定而不是固定 TTL：新 K 线一收盘就必须重新取，
 * 否则决策会用上一根 K 线，而 INV-8 要求决策绑定具体的已收盘 K 线。
 */
export function isMarketSnapshotReusable(input: {
  fetchedAt: number;
  now: number;
  timeframe: string;
}): boolean {
  const span = timeframeMilliseconds(input.timeframe);
  if (span === null) return false;
  if (!Number.isFinite(input.fetchedAt) || !Number.isFinite(input.now)) return false;
  if (input.now < input.fetchedAt) return false;
  return Math.floor(input.fetchedAt / span) === Math.floor(input.now / span);
}
