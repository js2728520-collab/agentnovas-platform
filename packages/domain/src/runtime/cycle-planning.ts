/**
 * 决策轮的周期规划。
 *
 * 「这一轮作用在哪根 K 线上」是决策轮最基础的判定：选错就是拿过期或未收盘的
 * 行情做决策，而下游的一切——快照、决策记录、订单意图、幂等键——都挂在它上面。
 *
 * 这套逻辑此前在 lib/strategy-runtime-worker.ts 的现货与永续两条路径里
 * **各写了一份**。两份当时是一致的，但没有任何机制保证它们继续一致。
 */

import type { StrategyCandle } from "../strategy-dsl.ts";

export type CycleCandleSelection<T> = {
  /** 本轮要决策的那根已收盘 K 线。 */
  selected: T;
  /** 喂给引擎的 K 线序列：从头到 selected 为止，指标需要历史。 */
  evaluationCandles: T[];
  /** selected 之后还有更新的 K 线，说明落后了，下一轮要立刻跟上。 */
  hasBacklog: boolean;
};

/**
 * 选出本轮的 K 线。返回 null 表示没有新的完整 K 线，调用方应当推迟本次租约。
 *
 * `lastCandleCloseTime` 为 null 表示这个部署还没做过决策，取最新一根；
 * 否则取第一根比上次更晚收盘的——**严格大于**，等于意味着这根已经处理过了。
 */
export function selectCycleCandle<T extends { closeTime: number }>(
  candles: readonly T[],
  lastCandleCloseTime: number | null,
): CycleCandleSelection<T> | null {
  const selected = lastCandleCloseTime === null
    ? candles.at(-1)
    : candles.find((candle) => candle.closeTime > lastCandleCloseTime);
  if (!selected) return null;
  const selectedIndex = candles.findIndex((candle) => candle.closeTime === selected.closeTime);
  return {
    selected,
    evaluationCandles: candles.slice(0, selectedIndex + 1),
    hasBacklog: selected.closeTime < candles.at(-1)!.closeTime,
  };
}

/**
 * 决策轮的幂等键。
 *
 * INV-8 要求相同 card/candle/contract 的重试返回同一决策轮。同一个部署在同一根
 * K 线上重跑必须算出同一个 id，所以这里只能用确定性输入——不许掺时间或随机数。
 */
export function deterministicCycleId(deploymentId: string, candleCloseTime: number) {
  return `runtime:${deploymentId}:${candleCloseTime}`;
}

/**
 * 共享决策轮的幂等键。
 *
 * 与 deterministicCycleId 的区别是身份不同：周期 id 认「哪个部署」，
 * 决策轮 id 认「哪张卡在哪根 K 线上的判断」。同一张卡的所有订阅者共享同一轮——
 * 判断本来就相同，重复算 N 次只是把同一段结论和同一次 LLM 解释生成 N 遍。
 *
 * 见 docs/adr/0018-shared-decision-rounds-and-per-portfolio-admission.md。
 */
export function deterministicDecisionRoundId(input: {
  strategyCode: string;
  symbol: string;
  timeframe: string;
  candleCloseTime: number;
}) {
  return `round:${input.strategyCode}:${input.symbol}:${input.timeframe}:${input.candleCloseTime}`;
}

/** 落后时 1 秒后重试追赶，跟上了就按 15 秒轮询。 */
export function nextPollAt(now: Date, hasBacklog: boolean) {
  return new Date(now.getTime() + (hasBacklog ? 1_000 : 15_000));
}

/**
 * 永续资金费率的拉取条数。
 *
 * 按评估区间跨越多少个结算周期估算，多要 10 条留余量，上限 10,000 条防止
 * 区间异常时打爆请求。至少 1 条——交易所接口不接受 limit=0。
 */
export function resolveFundingWindowLimit(input: {
  startTime: number;
  endTime: number;
  fundingIntervalHours: number;
}) {
  const intervalMs = input.fundingIntervalHours * 3_600_000;
  const estimated = Math.ceil((input.endTime - input.startTime) / intervalMs) + 10;
  return Math.max(Math.min(estimated, 10_000), 1);
}

/**
 * 官方现货行情的严格校验（INV-7 的数据质量闸门）。
 *
 * 不合格就抛，不做任何补齐或跳过：一根坏 K 线流进引擎，产出的是一个看起来
 * 正常、实际上没有依据的决策。
 *
 * 注意 `Object.values(candle).every(Number.isFinite)`：它要求 K 线对象上
 * **只有数字字段**。现在的现货适配器正好如此。若将来适配器往里塞了字符串字段
 * （例如 provider），这里会把合法 K 线判成非法——届时应改成逐字段检查，
 * 而不是放宽校验。
 */
export function assertRuntimeSpotCandles(candles: readonly StrategyCandle[]): void {
  if (candles.length < 2) throw new Error("官方现货运行周期缺少足够的完整 K 线");
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!Object.values(candle).every(Number.isFinite)
      || candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0
      || candle.openTime >= candle.closeTime
      || (index > 0 && candle.openTime <= candles[index - 1].openTime)) {
      throw new Error("官方现货行情响应未通过严格校验");
    }
  }
}
