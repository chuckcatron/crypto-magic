import { atrLast, emaLast, rsiLastTwo, trailing } from '../indicators';
import type { MarketSeries } from '../series';
import type { Bar, EntrySignal } from '../types';
import type { IntradayStrategy } from './types';

const FAST = 20;
const SLOW = 50;
/** Trailing 4-hour bars the EMAs are computed over. */
const TREND_WINDOW = 300;
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;
/** Trailing 15-minute bars RSI and ATR are computed over. */
const WINDOW_15 = 300;
const LONG_TRIGGER = 40;
const SHORT_TRIGGER = 60;
const STOP_ATR = 2;
const TARGET_ATR = 3;
const MIN_TARGET_FRACTION = 0.0032;
const MAX_HOLD_SECONDS = 48 * 3600;

type Trend = 'UP' | 'DOWN' | 'NONE';

/**
 * F3 — Trend pullback, long or short (EXPERIMENT-008). Trade with the 4-hour
 * trend, entering on 15-minute bars as a pullback ends.
 *
 * Trend from the latest closed 4-hour bar, EMAs over its trailing 300 bars: up
 * when EMA(20) > EMA(50) and close > EMA(50), down on the mirror image. At a
 * 15-minute close: long in an uptrend when RSI(14) crosses up through 40, short
 * in a downtrend when it crosses down through 60. Both RSI values come from one
 * computation over the trailing 300 bars ending at this close. Stop 2 × ATR(14),
 * target 3 × ATR(14), 48-hour hold; skipped when the target is under 0.32% away.
 */
export const trendPullback: IntradayStrategy = {
  id: 'F3',
  name: 'F3-trend-pullback',
  // 300 four-hour bars plus one of slack: the longest window it reads.
  warmupM5Bars: (TREND_WINDOW + 1) * 48,

  evaluate(series: MarketSeries): EntrySignal | null {
    if (!series.closed15) return null;
    const m15 = series.m15;
    const k = m15.length - 1;
    if (m15.length < WINDOW_15 || series.h4.length < TREND_WINDOW) return null;

    const trend = trendOf(series.h4);
    if (trend === 'NONE') return null;

    const window = trailing(m15, k, WINDOW_15)!;
    const [previous, current] = rsiLastTwo(window, RSI_PERIOD);
    if (previous === undefined || current === undefined) return null;

    let direction: 'LONG' | 'SHORT';
    if (trend === 'UP' && previous < LONG_TRIGGER && current >= LONG_TRIGGER) direction = 'LONG';
    else if (trend === 'DOWN' && previous > SHORT_TRIGGER && current <= SHORT_TRIGGER)
      direction = 'SHORT';
    else return null;

    const atr = atrLast(window, ATR_PERIOD);
    if (atr === undefined || !(atr > 0)) return null;
    const close = m15[k]!.c;
    const targetDistance = TARGET_ATR * atr;
    if (targetDistance / close < MIN_TARGET_FRACTION) return null;

    return {
      direction,
      stopDistance: STOP_ATR * atr,
      targetDistance,
      maxHoldSeconds: MAX_HOLD_SECONDS,
      reason:
        `${trend === 'UP' ? 'uptrend' : 'downtrend'} pullback ends: RSI ` +
        `${previous.toFixed(1)} → ${current.toFixed(1)}`,
    };
  },
};

/** Trend of the 4-hour series, memoized on its newest bar (it only changes when one closes). */
let memo: { bars: readonly Bar[]; time: number; length: number; trend: Trend } | null = null;

function trendOf(h4: readonly Bar[]): Trend {
  const last = h4.at(-1)!;
  if (memo && memo.bars === h4 && memo.time === last.t && memo.length === h4.length) {
    return memo.trend;
  }
  const window = trailing(h4, h4.length - 1, TREND_WINDOW)!;
  const fast = emaLast(window, FAST);
  const slow = emaLast(window, SLOW);
  let trend: Trend = 'NONE';
  if (fast !== undefined && slow !== undefined) {
    if (fast > slow && last.c > slow) trend = 'UP';
    else if (fast < slow && last.c < slow) trend = 'DOWN';
  }
  memo = { bars: h4, time: last.t, length: h4.length, trend };
  return trend;
}
