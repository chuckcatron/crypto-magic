import { atr, ema, rsi, type Candle } from '@crypto-magic/core';
import type { Bar } from './types';

/**
 * Indicator helpers over a fixed trailing window.
 *
 * The smoothed indicators (EMA, RSI, ATR) are the repo's own definitions in
 * @crypto-magic/core, run over exactly the trailing window the protocol names.
 * Running them over "all history" in the backtest and over whatever the bot
 * fetched live would make them two different indicators with one name; this
 * repo has had that bug before (see Strategy.lookbackBars in core).
 */

/** The last `count` bars ending at `end` (inclusive), or null if there are not enough. */
export function trailing(bars: readonly Bar[], end: number, count: number): Bar[] | null {
  const start = end - count + 1;
  if (start < 0 || end >= bars.length) return null;
  return bars.slice(start, end + 1);
}

/** EMA of the closes, seeded inside the window; the value at the window's last bar. */
export function emaLast(window: readonly Bar[], period: number): number | undefined {
  return ema(
    window.map((b) => b.c),
    period,
  ).at(-1);
}

/** Wilder RSI of the closes over the window: the values at its last two bars. */
export function rsiLastTwo(
  window: readonly Bar[],
  period: number,
): [number | undefined, number | undefined] {
  const series = rsi(
    window.map((b) => b.c),
    period,
  );
  return [series.at(-2), series.at(-1)];
}

/** Wilder ATR over the window: the value at its last bar. */
export function atrLast(window: readonly Bar[], period: number): number | undefined {
  return atr(window.map(toCandle), period).at(-1);
}

function toCandle(bar: Bar): Candle {
  // ATR reads only high, low and close; the rest satisfies the type.
  return {
    productId: '',
    granularity: 'FIFTEEN_MINUTE',
    openTime: bar.t,
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  };
}

/** Population standard deviation (divide by n), two-pass for accuracy. */
export function populationStdev(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i]!;
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]! - mean;
    squares += d * d;
  }
  return Math.sqrt(squares / n);
}

/** Median; the mean of the two middle values when the count is even. Sorts a copy. */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const sorted = Float64Array.from(values).sort();
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface Bands {
  readonly middle: number;
  readonly upper: number;
  readonly lower: number;
  /** (upper − lower) ÷ middle. */
  readonly bandwidth: number;
}

/**
 * Bollinger bands at `end`: SMA(period) of the closes ± k × their population
 * standard deviation. Null if there are fewer than `period` bars.
 */
export function bollinger(bars: readonly Bar[], end: number, period = 20, k = 2): Bands | null {
  const start = end - period + 1;
  if (start < 0 || end >= bars.length) return null;
  const closes = new Float64Array(period);
  for (let i = 0; i < period; i++) closes[i] = bars[start + i]!.c;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i]!;
  const middle = sum / period;
  const sd = populationStdev(closes);
  const upper = middle + k * sd;
  const lower = middle - k * sd;
  return { middle, upper, lower, bandwidth: (upper - lower) / middle };
}
