import { median, populationStdev } from '../indicators';
import type { MarketSeries } from '../series';
import type { EntrySignal } from '../types';
import type { IntradayStrategy } from './types';

/** 7 days of 5-minute bars. */
const LOOKBACK = 2016;
/** The move is measured over the last 3 bars: 15 minutes. */
const SPAN = 3;
const SIGMAS = 4;
const VOLUME_MULTIPLE = 3;
const MIN_MOVE = 0.01;
/** Stop and target are each this fraction of the move, from the fill. */
const EXIT_FRACTION = 0.5;
const MAX_HOLD_SECONDS = 4 * 3600;

/**
 * F1 — Flush catcher (EXPERIMENT-008). Fade a fast move on heavy volume, which
 * is often forced (liquidations, stop runs) and partly snaps back.
 *
 * At bar i: r = ln(close[i] / close[i-3]); σ = population standard deviation of
 * that 3-bar log return over bars i-2016 … i-1; V = volume of bars i-2 … i;
 * Vmed = median of the 3-bar volume total over bars i-2016 … i-1.
 * Long when r ≤ -4σ, V ≥ 3·Vmed and the move is at least 1%; short on the
 * mirror image. Stop and target each 0.5 × the move from the fill; 4-hour hold.
 */
export const flushCatcher: IntradayStrategy = {
  id: 'F1',
  name: 'F1-flush-catcher',
  warmupM5Bars: LOOKBACK + SPAN + 1,

  evaluate(series: MarketSeries): EntrySignal | null {
    const bars = series.m5;
    const i = bars.length - 1;
    // r at bar i-2016 needs the close at i-2019.
    if (i < LOOKBACK + SPAN) return null;

    const close = bars[i]!.c;
    const before = bars[i - SPAN]!.c;
    const move = Math.abs(close - before) / before;
    // Cheapest test first: almost every bar fails it, and the rest is exact
    // regardless of the order the conditions are checked in.
    if (move < MIN_MOVE) return null;

    const r = Math.log(close / before);
    const returns = new Float64Array(LOOKBACK);
    for (let n = 0, j = i - LOOKBACK; j <= i - 1; n++, j++) {
      returns[n] = Math.log(bars[j]!.c / bars[j - SPAN]!.c);
    }
    const sigma = populationStdev(returns);
    if (!(sigma > 0)) return null;
    const flushDown = r <= -SIGMAS * sigma;
    const flushUp = r >= SIGMAS * sigma;
    if (!flushDown && !flushUp) return null;

    const volume = bars[i]!.v + bars[i - 1]!.v + bars[i - 2]!.v;
    const volumes = new Float64Array(LOOKBACK);
    for (let n = 0, j = i - LOOKBACK; j <= i - 1; n++, j++) {
      volumes[n] = bars[j]!.v + bars[j - 1]!.v + bars[j - 2]!.v;
    }
    const typical = median(volumes);
    if (!(volume >= VOLUME_MULTIPLE * typical)) return null;

    const distance = EXIT_FRACTION * Math.abs(close - before);
    return {
      direction: flushDown ? 'LONG' : 'SHORT',
      stopDistance: distance,
      targetDistance: distance,
      maxHoldSeconds: MAX_HOLD_SECONDS,
      reason:
        `${flushDown ? 'down' : 'up'}-flush ${(r * 100).toFixed(2)}% in 15m ` +
        `(${(r / sigma).toFixed(1)}σ, volume ${(volume / typical).toFixed(1)}× median)`,
    };
  },
};
