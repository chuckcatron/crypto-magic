import type { Candle } from '../types/market';

/**
 * Indicator series are aligned index-for-index with their input. Entries before
 * the indicator has enough data are `undefined` rather than 0 — a zero here
 * would silently look like a real reading and trigger trades during warmup.
 */
export type Series = (number | undefined)[];

export function sma(values: number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values
 * (Wilder/StockCharts convention) so results match charting platforms.
 */
export function ema(values: number[], period: number): Series {
  assertPeriod(period);
  const out: Series = new Array(values.length).fill(undefined);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index using Wilder's smoothing. Returns 0..100. */
export function rsi(values: number[], period = 14): Series {
  assertPeriod(period);
  const out: Series = new Array(values.length).fill(undefined);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  // A period with no losses is RSI 100 by definition; guard the divide.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function trueRange(candles: Candle[]): Series {
  const out: Series = new Array(candles.length).fill(undefined);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i === 0) {
      out[i] = c.high - c.low;
      continue;
    }
    const prevClose = candles[i - 1]!.close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  return out;
}

/** Average True Range using Wilder's smoothing — the volatility unit we size and stop with. */
export function atr(candles: Candle[], period = 14): Series {
  assertPeriod(period);
  const out: Series = new Array(candles.length).fill(undefined);
  if (candles.length < period + 1) return out;

  const tr = trueRange(candles);
  let sum = 0;
  // Skip index 0: its true range has no previous close and would bias the seed.
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** True when `fast` moved from at-or-below `slow` to strictly above it at `index`. */
export function crossedAbove(fast: Series, slow: Series, index: number): boolean {
  if (index < 1) return false;
  const f0 = fast[index - 1];
  const s0 = slow[index - 1];
  const f1 = fast[index];
  const s1 = slow[index];
  if (f0 === undefined || s0 === undefined || f1 === undefined || s1 === undefined) return false;
  return f0 <= s0 && f1 > s1;
}

export function crossedBelow(fast: Series, slow: Series, index: number): boolean {
  if (index < 1) return false;
  const f0 = fast[index - 1];
  const s0 = slow[index - 1];
  const f1 = fast[index];
  const s1 = slow[index];
  if (f0 === undefined || s0 === undefined || f1 === undefined || s1 === undefined) return false;
  return f0 >= s0 && f1 < s1;
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`indicator period must be a positive integer, got ${period}`);
  }
}
