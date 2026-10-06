import { rsi } from '@crypto-magic/core';
import { DAY, type Bar } from '../types';

/**
 * Daily bars for many coins, with the point-in-time reads EXPERIMENT-009's
 * rules need. Every read takes the decision day and looks only at bars that
 * opened on or before it: the simulation hands rules this object, never a raw
 * array they could index past today.
 */
export class DailyMarket {
  private readonly bars = new Map<string, readonly Bar[]>();
  private readonly index = new Map<string, Map<number, number>>();
  /** Prefix sums of dollar volume (volume × close), per coin. */
  private readonly dollarVolume = new Map<string, Float64Array>();
  private readonly universeCache = new Map<number, readonly string[]>();

  constructor(
    coins: ReadonlyMap<string, readonly Bar[]>,
    private readonly options: { universeSize: number; minHistory: number; volumeDays: number } = {
      universeSize: 50,
      minHistory: 60,
      volumeDays: 30,
    },
  ) {
    for (const [symbol, bars] of coins) {
      if (bars.length === 0) continue;
      for (let i = 1; i < bars.length; i++) {
        if (bars[i]!.t <= bars[i - 1]!.t) throw new Error(`${symbol}: bars out of order at ${i}`);
      }
      this.bars.set(symbol, bars);
      this.index.set(symbol, new Map(bars.map((b, i) => [b.t, i])));
      const sums = new Float64Array(bars.length + 1);
      for (let i = 0; i < bars.length; i++) sums[i + 1] = sums[i]! + bars[i]!.v * bars[i]!.c;
      this.dollarVolume.set(symbol, sums);
    }
  }

  get symbols(): string[] {
    return [...this.bars.keys()];
  }

  /** The bar that opened on `day`, if the coin traded that day. */
  bar(symbol: string, day: number): Bar | undefined {
    const i = this.index.get(symbol)?.get(day);
    return i === undefined ? undefined : this.bars.get(symbol)![i];
  }

  /** The last bar that opened before `day`. */
  lastBarBefore(symbol: string, day: number): Bar | undefined {
    const bars = this.bars.get(symbol);
    if (!bars) return undefined;
    const i = this.lastIndexAtOrBefore(symbol, day - DAY);
    return i < 0 ? undefined : bars[i];
  }

  /** Bars up to and including `day`. */
  historyLength(symbol: string, day: number): number {
    return this.lastIndexAtOrBefore(symbol, day) + 1;
  }

  /** Highest close over the `days` calendar days before `day` (today excluded). */
  highestClose(symbol: string, day: number, days: number): number | undefined {
    return this.extreme(symbol, day, days, Math.max);
  }

  /** Lowest close over the `days` calendar days before `day` (today excluded). */
  lowestClose(symbol: string, day: number, days: number): number | undefined {
    return this.extreme(symbol, day, days, Math.min);
  }

  /** Mean close of the last `count` bars up to and including `day`. */
  sma(symbol: string, day: number, count: number): number | undefined {
    const bars = this.bars.get(symbol);
    const end = this.lastIndexAtOrBefore(symbol, day);
    if (!bars || end < count - 1) return undefined;
    let sum = 0;
    for (let i = end - count + 1; i <= end; i++) sum += bars[i]!.c;
    return sum / count;
  }

  /** close(day) ÷ close(day − n days) − 1; undefined unless both days have a bar. */
  returnOver(symbol: string, day: number, days: number): number | undefined {
    const now = this.bar(symbol, day);
    const then = this.bar(symbol, day - days * DAY);
    return now && then ? now.c / then.c - 1 : undefined;
  }

  /** Wilder RSI from @crypto-magic/core over the trailing `window` closes ending at `day`. */
  rsi(symbol: string, day: number, period: number, window: number): number | undefined {
    const bars = this.bars.get(symbol);
    const end = this.lastIndexAtOrBefore(symbol, day);
    if (!bars || end < window - 1 || bars[end]!.t !== day) return undefined;
    const closes: number[] = [];
    for (let i = end - window + 1; i <= end; i++) closes.push(bars[i]!.c);
    return rsi(closes, period).at(-1);
  }

  /** Dollar volume of the bar on `day`. */
  dollarVolumeOn(symbol: string, day: number): number | undefined {
    const bar = this.bar(symbol, day);
    return bar ? bar.v * bar.c : undefined;
  }

  /**
   * Mean dollar volume over the bars that opened in [from, to] (both UTC
   * midnights, inclusive). Undefined if there are none.
   */
  meanDollarVolume(symbol: string, from: number, to: number): number | undefined {
    const sums = this.dollarVolume.get(symbol);
    if (!sums) return undefined;
    const end = this.lastIndexAtOrBefore(symbol, to);
    const start = this.lastIndexAtOrBefore(symbol, from - DAY) + 1;
    if (end < start) return undefined;
    return (sums[end + 1]! - sums[start]!) / (end - start + 1);
  }

  /**
   * EXPERIMENT-009's universe at the close of `day`: coins with a bar that
   * day and at least `minHistory` bars so far, ranked by mean dollar volume
   * over the `volumeDays` days ending that day; the top `universeSize`.
   * Ties go by symbol.
   */
  universe(day: number): readonly string[] {
    const cached = this.universeCache.get(day);
    if (cached) return cached;
    const ranked: { symbol: string; volume: number }[] = [];
    for (const symbol of this.bars.keys()) {
      if (!this.bar(symbol, day)) continue;
      if (this.historyLength(symbol, day) < this.options.minHistory) continue;
      const volume = this.meanDollarVolume(symbol, day - (this.options.volumeDays - 1) * DAY, day);
      if (volume !== undefined) ranked.push({ symbol, volume });
    }
    ranked.sort(
      (a, b) => b.volume - a.volume || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0),
    );
    const top = ranked.slice(0, this.options.universeSize).map((r) => r.symbol);
    this.universeCache.set(day, top);
    return top;
  }

  private extreme(
    symbol: string,
    day: number,
    days: number,
    pick: (a: number, b: number) => number,
  ): number | undefined {
    const bars = this.bars.get(symbol);
    if (!bars) return undefined;
    let i = this.lastIndexAtOrBefore(symbol, day - DAY);
    let value: number | undefined;
    for (; i >= 0 && bars[i]!.t >= day - days * DAY; i--) {
      value = value === undefined ? bars[i]!.c : pick(value, bars[i]!.c);
    }
    return value;
  }

  /** Index of the last bar opening at or before `t`, or -1. */
  private lastIndexAtOrBefore(symbol: string, t: number): number {
    const bars = this.bars.get(symbol);
    if (!bars) return -1;
    const exact = this.index.get(symbol)!.get(t);
    if (exact !== undefined) return exact;
    let lo = 0;
    let hi = bars.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid]!.t <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }
}
