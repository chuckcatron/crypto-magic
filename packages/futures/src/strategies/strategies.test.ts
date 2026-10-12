import { rsi } from '@crypto-magic/core';
import { describe, expect, it } from 'vitest';
import { MarketSeries } from '../series';
import { bar, barsFromCloses, prng, randomWalk, seriesOf, T0 } from '../testing/bars';
import { FIVE_MINUTES, FOUR_HOURS, type Bar, type EntrySignal } from '../types';
import { flushCatcher } from './flush-catcher';
import { squeezeBreakout } from './squeeze-breakout';
import { trendPullback } from './trend-pullback';
import type { IntradayStrategy } from './types';

/** Continue a series of bars with the given closes and volume. */
function extend(bars: Bar[], closes: readonly number[], volume: number): Bar[] {
  let previous = bars.at(-1)!;
  const out = [...bars];
  for (const close of closes) {
    const next = { ...bar(previous.t + FIVE_MINUTES, previous.c, close), v: volume };
    out.push(next);
    previous = next;
  }
  return out;
}

describe('F1 flush catcher', () => {
  const calm = randomWalk(2100, { seed: 7, sigma: 0.001 });
  const p = calm.at(-1)!.c;

  it('buys a 2% fall in 15 minutes on ten times the usual volume', () => {
    const bars = extend(calm, [p * 0.993, p * 0.986, p * 0.98], 100);
    const signal = flushCatcher.evaluate(seriesOf(bars))!;
    expect(signal.direction).toBe('LONG');
    expect(signal.stopDistance).toBeCloseTo(0.01 * p);
    expect(signal.targetDistance).toBeCloseTo(0.01 * p);
    expect(signal.maxHoldSeconds).toBe(4 * 3600);
  });

  it('sells the mirror image', () => {
    const bars = extend(calm, [p * 1.007, p * 1.014, p * 1.02], 100);
    expect(flushCatcher.evaluate(seriesOf(bars))!.direction).toBe('SHORT');
  });

  it('ignores the same move on ordinary volume', () => {
    const bars = extend(calm, [p * 0.993, p * 0.986, p * 0.98], 10);
    expect(flushCatcher.evaluate(seriesOf(bars))).toBeNull();
  });

  it('ignores a move under 1%, however many sigmas it is', () => {
    const quiet = randomWalk(2100, { seed: 7, sigma: 0.0001 });
    const q = quiet.at(-1)!.c;
    const bars = extend(quiet, [q * 0.997, q * 0.994, q * 0.992], 100);
    expect(flushCatcher.evaluate(seriesOf(bars))).toBeNull();
  });

  it('waits for a full 7-day window', () => {
    const short = randomWalk(1000, { seed: 7, sigma: 0.001 });
    const s = short.at(-1)!.c;
    expect(
      flushCatcher.evaluate(seriesOf(extend(short, [s * 0.98, s * 0.97, s * 0.96], 100))),
    ).toBeNull();
  });
});

describe('F2 squeeze breakout', () => {
  // A week of ordinary volatility, then a day dead flat: the flat bars are squeeze bars.
  const volatile = randomWalk(1800, { seed: 11, sigma: 0.002 });
  const flatPrice = volatile.at(-1)!.c;
  const squeezed = extend(volatile, new Array<number>(300).fill(flatPrice), 10);

  it('buys a close above the upper band within an hour of a squeeze', () => {
    const bars = extend(squeezed, [flatPrice * 1.003, flatPrice * 1.006, flatPrice * 1.01], 10);
    const series = seriesOf(bars);
    expect(series.closed15).toBe(true);
    const signal = squeezeBreakout.evaluate(series)!;
    expect(signal.direction).toBe('LONG');
    expect(signal.targetDistance).toBeCloseTo(2 * signal.stopDistance);
    expect(signal.targetDistance / flatPrice).toBeGreaterThanOrEqual(0.0032);
  });

  it('sells a close below the lower band', () => {
    const bars = extend(squeezed, [flatPrice * 0.997, flatPrice * 0.994, flatPrice * 0.99], 10);
    expect(squeezeBreakout.evaluate(seriesOf(bars))!.direction).toBe('SHORT');
  });

  it('ignores a breakout with no squeeze in the previous four bars', () => {
    const random = prng(3);
    const wiggle = Array.from({ length: 30 }, () => flatPrice * (1 + (random() - 0.5) * 0.004));
    const awake = extend(squeezed, wiggle, 10);
    const last = awake.at(-1)!.c;
    const bars = extend(awake, [last * 1.01, last * 1.02, last * 1.03], 10);
    expect(squeezeBreakout.evaluate(seriesOf(bars))).toBeNull();
  });

  it('evaluates only when a 15-minute bar has just closed', () => {
    const bars = extend(squeezed, [flatPrice * 1.003, flatPrice * 1.006], 10);
    expect(squeezeBreakout.evaluate(seriesOf(bars))).toBeNull();
  });
});

describe('F3 trend pullback', () => {
  /**
   * A steady trend with a 4-hour swing on top. Every 4-hour close lands on the
   * same phase of the swing, so the 4-hour trend is clean, while the 15-minute
   * RSI swings through 40 and 60 every cycle.
   */
  function trending(drift: number, seed: number): Bar[] {
    const random = prng(seed);
    const closes: number[] = [];
    for (let i = 0; i < 18_500; i++) {
      const swing = 0.025 * Math.sin((2 * Math.PI * i) / 48);
      closes.push(100 * Math.exp(drift * i) * (1 + swing) * (1 + (random() - 0.5) * 0.0004));
    }
    return barsFromCloses(closes);
  }

  function signalsOver(bars: readonly Bar[]): { index: number; signal: EntrySignal }[] {
    const series = new MarketSeries();
    const found: { index: number; signal: EntrySignal }[] = [];
    bars.forEach((b, index) => {
      series.append(b);
      const signal = trendPullback.evaluate(series);
      if (signal) found.push({ index, signal });
    });
    return found;
  }

  it('in an uptrend, only buys, and only as 15-minute RSI crosses up through 40', () => {
    const bars = trending(0.0001, 5);
    const found = signalsOver(bars);
    expect(found.length).toBeGreaterThan(5);
    for (const { index, signal } of found) {
      expect(signal.direction).toBe('LONG');
      // Recompute RSI over the same 300 fifteen-minute closes.
      const series = seriesOf(bars.slice(0, index + 1));
      const closes = series.m15.slice(-300).map((b) => b.c);
      const values = rsi(closes, 14);
      expect(values[298]!).toBeLessThan(40);
      expect(values[299]!).toBeGreaterThanOrEqual(40);
      expect(signal.targetDistance).toBeCloseTo(1.5 * signal.stopDistance);
    }
  });

  it('in a downtrend, only sells', () => {
    const found = signalsOver(trending(-0.0001, 9));
    expect(found.length).toBeGreaterThan(5);
    expect(found.every(({ signal }) => signal.direction === 'SHORT')).toBe(true);
  });

  it('needs 300 four-hour bars first', () => {
    expect(signalsOver(trending(0.0001, 5).slice(0, 14_000))).toEqual([]);
  });
});

describe('backtest and live give the same signals', () => {
  /**
   * Regime-switching data with injected flushes, so every strategy fires. The
   * backtest evaluates on all history; the paper engine evaluates on a series
   * it rebuilt from a recent fetch. They must agree bar for bar.
   */
  function marketLike(count: number): Bar[] {
    const random = prng(42);
    let price = 30_000;
    const out: Bar[] = [];
    for (let i = 0; i < count; i++) {
      const day = Math.floor(i / 288);
      const sigma = day % 4 < 2 ? 0.0025 : 0.0004;
      const drift = Math.floor(day / 10) % 2 === 0 ? 0.0001 : -0.0001;
      const open = price;
      let volume = 5 + random() * 10;
      if (i % 700 === 699) {
        price *= 0.985;
        volume *= 12;
      } else {
        price *= Math.exp(drift + sigma * (random() - 0.5) * 3.4);
      }
      out.push({ ...bar(T0 + i * FIVE_MINUTES, open, price), v: volume });
    }
    return out;
  }

  const bars = marketLike(14_500 + 3_000);

  /** Compare at bars with index ≡ offset (mod step); 15-minute closes are index ≡ 2 (mod 3). */
  function compare(strategy: IntradayStrategy, step: number, offset = 0): number {
    const full = new MarketSeries();
    let signals = 0;
    for (let i = 0; i < bars.length; i++) {
      full.append(bars[i]!);
      if (i < bars.length - 3_000 || i % step !== offset) continue;
      const fromBacktest = strategy.evaluate(full);
      // What the live engine does: fetch at least the warmup, from a 4-hour boundary.
      const since =
        Math.floor((bars[i]!.t - strategy.warmupM5Bars * FIVE_MINUTES) / FOUR_HOURS) * FOUR_HOURS;
      const live = new MarketSeries();
      for (let j = 0; j <= i; j++) if (bars[j]!.t >= since) live.append(bars[j]!);
      const fromLive = strategy.evaluate(live);
      expect(fromLive).toEqual(fromBacktest);
      if (fromBacktest) signals++;
    }
    return signals;
  }

  it('F1', () => {
    expect(compare(flushCatcher, 1)).toBeGreaterThan(0);
  });

  it('F2', () => {
    expect(compare(squeezeBreakout, 3, 2)).toBeGreaterThan(0);
  });

  it('F3', () => {
    expect(compare(trendPullback, 3, 2)).toBeGreaterThan(0);
  }, 60_000);
});
