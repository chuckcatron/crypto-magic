import { MarketSeries } from '../series';
import type { IntradayStrategy } from '../strategies/types';
import { FIVE_MINUTES, type Bar, type EntrySignal } from '../types';

/** Deterministic PRNG (mulberry32), so a failing test fails the same way every time. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 2026-01-05 00:00 UTC, a Monday. */
export const T0 = Date.UTC(2026, 0, 5) / 1000;

/**
 * A bar from its open and close, with a small wick either side.
 * `wick` is the fraction above the higher and below the lower of open/close.
 */
export function bar(t: number, o: number, c: number, v = 10, wick = 0.0005): Bar {
  return { t, o, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), c, v };
}

/** Consecutive 5-minute bars through the given closes; each opens at the previous close. */
export function barsFromCloses(closes: readonly number[], start = T0, open = closes[0]!): Bar[] {
  const out: Bar[] = [];
  let previous = open;
  closes.forEach((close, i) => {
    out.push(bar(start + i * FIVE_MINUTES, previous, close));
    previous = close;
  });
  return out;
}

/** A random walk of 5-minute bars with log-return volatility `sigma` per bar. */
export function randomWalk(
  count: number,
  options: { seed?: number; start?: number; price?: number; sigma?: number } = {},
): Bar[] {
  const random = prng(options.seed ?? 1);
  const sigma = options.sigma ?? 0.001;
  let price = options.price ?? 100;
  const closes: number[] = [];
  for (let i = 0; i < count; i++) {
    // Sum of uniforms: close enough to normal for a test series.
    const z = (random() + random() + random() + random() - 2) * Math.sqrt(3);
    price *= Math.exp(sigma * z);
    closes.push(price);
  }
  return barsFromCloses(closes, options.start ?? T0, options.price ?? 100).map((b) => ({
    ...b,
    v: 5 + random() * 10,
  }));
}

/** A series holding the given bars. */
export function seriesOf(bars: readonly Bar[]): MarketSeries {
  const series = new MarketSeries();
  for (const b of bars) series.append(b);
  return series;
}

/** A strategy that signals at the closes of the given bar open times, and nowhere else. */
export function scripted(signals: ReadonlyMap<number, EntrySignal>): IntradayStrategy {
  return {
    id: 'F1',
    name: 'scripted',
    warmupM5Bars: 0,
    evaluate(series) {
      const last = series.m5.at(-1);
      return last ? (signals.get(last.t) ?? null) : null;
    },
  };
}

export function signal(overrides: Partial<EntrySignal> = {}): EntrySignal {
  return {
    direction: 'LONG',
    stopDistance: 1,
    targetDistance: 2,
    maxHoldSeconds: 3600,
    reason: 'test',
    ...overrides,
  };
}
