import { normalizeStrategySpecification, type StrategySpecification } from "@/lib/backtest-engine";
import type { SpotCandle } from "@/lib/market-data";

export type DemoStrategySignal = {
  action: "enter" | "exit" | "hold";
  reason: string;
  specification: StrategySpecification;
  metrics: {
    lastPrice: number;
    ema20: number;
    ema60: number;
    previousEma20: number;
    previousEma60: number;
    rsi14: number;
    volumeRatio: number;
    channelHigh20: number;
    channelLow10: number;
    candleCloseTime: string;
  };
};

function ema(values: number[], period: number) {
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const output = Array(values.length).fill(Number.NaN) as number[];
  output[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    output[index] = current;
  }
  return output;
}

function rsi(values: number[], period = 14) {
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  if (losses === 0) return 100;
  const relativeStrength = (gains / period) / (losses / period);
  return 100 - 100 / (1 + relativeStrength);
}

export function evaluateDemoStrategySignal(
  rawSpecification: Record<string, unknown>,
  candles: SpotCandle[],
  hasOpenPosition: boolean,
): DemoStrategySignal {
  if (candles.length < 80) throw new Error("实时策略判定至少需要 80 根完整K线");
  const specification = normalizeStrategySpecification(rawSpecification);
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const fast = ema(closes, 20);
  const slow = ema(closes, 60);
  const volumeAverage = ema(volumes, 20);
  const lastIndex = candles.length - 1;
  const previousIndex = lastIndex - 1;
  const last = candles[lastIndex];
  const strength = rsi(closes);
  const channelHigh20 = Math.max(...candles.slice(lastIndex - 20, lastIndex).map((candle) => candle.high));
  const channelLow10 = Math.min(...candles.slice(lastIndex - 10, lastIndex).map((candle) => candle.low));
  const volumeRatio = volumeAverage[lastIndex] > 0 ? last.volume / volumeAverage[lastIndex] : 0;
  let action: DemoStrategySignal["action"] = "hold";
  let reason = "当前完整K线未触发策略入场或退出条件";

  if (hasOpenPosition) {
    if (specification.style === "趋势跟随" && fast[lastIndex] < slow[lastIndex]) {
      action = "exit";
      reason = "EMA20 已下穿 EMA60，趋势退出条件成立";
    } else if (specification.style === "区间交易" && strength >= 60) {
      action = "exit";
      reason = "RSI14 已恢复至 60 以上，区间退出条件成立";
    } else if (specification.style === "突破动量" && last.close < channelLow10) {
      action = "exit";
      reason = "收盘价跌破前 10 根K线低点，通道退出条件成立";
    }
  } else {
    const volumeConfirmed = volumeRatio >= 0.85;
    if (specification.style === "趋势跟随" && fast[lastIndex] > slow[lastIndex] && fast[previousIndex] <= slow[previousIndex] && volumeConfirmed) {
      action = "enter";
      reason = "EMA20 上穿 EMA60 且成交量确认，趋势入场条件成立";
    } else if (specification.style === "区间交易" && strength <= 30 && last.close > last.open) {
      action = "enter";
      reason = "RSI14 进入超卖区并出现阳线，区间入场条件成立";
    } else if (specification.style === "突破动量" && last.close > channelHigh20 && volumeConfirmed) {
      action = "enter";
      reason = "收盘价突破前 20 根K线高点且成交量确认，动量入场条件成立";
    }
  }

  return {
    action,
    reason,
    specification,
    metrics: {
      lastPrice: last.close,
      ema20: Number(fast[lastIndex].toFixed(8)),
      ema60: Number(slow[lastIndex].toFixed(8)),
      previousEma20: Number(fast[previousIndex].toFixed(8)),
      previousEma60: Number(slow[previousIndex].toFixed(8)),
      rsi14: Number(strength.toFixed(4)),
      volumeRatio: Number(volumeRatio.toFixed(4)),
      channelHigh20: Number(channelHigh20.toFixed(8)),
      channelLow10: Number(channelLow10.toFixed(8)),
      candleCloseTime: new Date(last.closeTime).toISOString(),
    },
  };
}
