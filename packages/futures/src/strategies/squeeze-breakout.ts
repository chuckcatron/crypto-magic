import { atrLast, bollinger, trailing } from '../indicators';
import type { MarketSeries } from '../series';
import type { EntrySignal } from '../types';
import type { IntradayStrategy } from './types';

const BB_PERIOD = 20;
const BB_K = 2;
/** 7 days of 15-minute bars. */
const SQUEEZE_LOOKBACK = 672;
/** A squeeze counts if it happened on any of the previous 4 bars (an hour). */
const RECENT = 4;
const ATR_PERIOD = 14;
const ATR_WINDOW = 300;
const STOP_ATR = 1.5;
const TARGET_ATR = 3;
/** Twice the base round trip (2 × 8 bps × 2 fills). */
const MIN_TARGET_FRACTION = 0.0032;
const MAX_HOLD_SECONDS = 24 * 3600;

/** Oldest bar any evaluation reads: bandwidths back to k-4-672, each over 20 closes. */
const REQUIRED_M15 = Math.max(RECENT + SQUEEZE_LOOKBACK + BB_PERIOD, ATR_WINDOW);

/**
 * F2 — Squeeze breakout (EXPERIMENT-008). Volatility clusters: a quiet stretch
 * ends in an expansion, and the first break tends to run.
 *
 * Bollinger(20, 2) on 15-minute closes. A squeeze bar's bandwidth is at or
 * below the lowest of the previous 672 bars. At a 15-minute close k, if any of
 * bars k-4 … k-1 was a squeeze bar: long on a close above the upper band, short
 * on a close below the lower. Stop 1.5 × ATR(14), target 3 × ATR(14), 24-hour
 * hold; skipped when the target is under 0.32% away.
 */
export const squeezeBreakout: IntradayStrategy = {
  id: 'F2',
  name: 'F2-squeeze-breakout',
  // Three 5-minute bars per 15-minute bar, plus one 15-minute bar of slack for
  // a first bucket that started mid-interval.
  warmupM5Bars: (REQUIRED_M15 + 1) * 3,

  evaluate(series: MarketSeries): EntrySignal | null {
    if (!series.closed15) return null;
    const bars = series.m15;
    const k = bars.length - 1;
    if (bars.length < REQUIRED_M15) return null;

    const bands = bollinger(bars, k, BB_PERIOD, BB_K);
    if (!bands) return null;
    const close = bars[k]!.c;
    let direction: 'LONG' | 'SHORT';
    if (close > bands.upper) direction = 'LONG';
    else if (close < bands.lower) direction = 'SHORT';
    else return null;

    if (!squeezedRecently(series, k)) return null;

    const window = trailing(bars, k, ATR_WINDOW);
    const atr = window ? atrLast(window, ATR_PERIOD) : undefined;
    if (atr === undefined || !(atr > 0)) return null;
    const targetDistance = TARGET_ATR * atr;
    if (targetDistance / close < MIN_TARGET_FRACTION) return null;

    return {
      direction,
      stopDistance: STOP_ATR * atr,
      targetDistance,
      maxHoldSeconds: MAX_HOLD_SECONDS,
      reason: `breakout ${direction === 'LONG' ? 'above' : 'below'} the band after a 7-day low in bandwidth`,
    };
  },
};

/** True if any of bars k-4 … k-1 had a bandwidth at or below the previous 672 bars' lowest. */
function squeezedRecently(series: MarketSeries, k: number): boolean {
  const bars = series.m15;
  const first = k - RECENT - SQUEEZE_LOOKBACK;
  const widths = new Float64Array(k - first);
  for (let j = first; j < k; j++) {
    const bands = bollinger(bars, j, BB_PERIOD, BB_K);
    if (!bands) return false;
    widths[j - first] = bands.bandwidth;
  }
  for (let j = k - RECENT; j < k; j++) {
    let lowest = Number.POSITIVE_INFINITY;
    for (let m = j - SQUEEZE_LOOKBACK; m < j; m++) lowest = Math.min(lowest, widths[m - first]!);
    if (widths[j - first]! <= lowest) return true;
  }
  return false;
}
