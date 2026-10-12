import { FIFTEEN_MINUTES, FIVE_MINUTES, FOUR_HOURS, type Bar } from './types';

interface MutableBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** How many bars of each size to keep when trimming. Live only; a backtest keeps all. */
export interface SeriesLimits {
  readonly m5: number;
  readonly m15: number;
  readonly h4: number;
}

/**
 * 5-minute bars, and the 15-minute and 4-hour bars built from them, exactly as
 * they would be known live: a bigger bar appears only once it has closed.
 *
 * A bigger bar normally closes with the 5-minute bar that ends on its boundary,
 * and `closed15` / `closed4h` say that just happened. Coinbase writes no
 * candle for a 5-minute interval with no trades. When the boundary bar is the
 * missing one, the bigger bar is closed late, by the first bar of the next
 * interval, and its flag stays false: the protocol skips that evaluation
 * rather than make it at a time the live bot could not have.
 */
export class MarketSeries {
  readonly m5: Bar[] = [];
  readonly m15: Bar[] = [];
  readonly h4: Bar[] = [];
  /** The 5-minute bar just appended closed a 15-minute bar on its boundary. */
  closed15 = false;
  /** The 5-minute bar just appended closed a 4-hour bar on its boundary. */
  closed4h = false;

  private partial15: MutableBar | null = null;
  private partial4h: MutableBar | null = null;

  constructor(private readonly limits?: SeriesLimits) {}

  /** The newest 5-minute bar's close time, or null before any bar. */
  get now(): number | null {
    const last = this.m5.at(-1);
    return last ? last.t + FIVE_MINUTES : null;
  }

  append(bar: Bar): void {
    const last = this.m5.at(-1);
    if (last && bar.t <= last.t) {
      throw new Error(`bars must be strictly ascending: ${bar.t} after ${last.t}`);
    }
    if (bar.t % FIVE_MINUTES !== 0) {
      throw new Error(`a 5-minute bar must open on a 5-minute boundary, got ${bar.t}`);
    }
    this.m5.push(bar);

    const fifteen = roll(bar, FIFTEEN_MINUTES, this.m15, this.partial15);
    this.partial15 = fifteen.partial;
    this.closed15 = fifteen.closedOnBoundary;

    const four = roll(bar, FOUR_HOURS, this.h4, this.partial4h);
    this.partial4h = four.partial;
    this.closed4h = four.closedOnBoundary;

    if (this.limits) this.trim(this.limits);
  }

  /** Drop the oldest bars in batches, so a long-running bot's memory stays flat. */
  private trim(limits: SeriesLimits): void {
    const slack = 1000;
    if (this.m5.length > limits.m5 + slack) this.m5.splice(0, this.m5.length - limits.m5);
    if (this.m15.length > limits.m15 + slack) this.m15.splice(0, this.m15.length - limits.m15);
    if (this.h4.length > limits.h4 + slack) this.h4.splice(0, this.h4.length - limits.h4);
  }
}

function roll(
  bar: Bar,
  span: number,
  closed: Bar[],
  current: MutableBar | null,
): { partial: MutableBar | null; closedOnBoundary: boolean } {
  const bucket = Math.floor(bar.t / span) * span;
  let partial = current;
  if (partial && partial.t !== bucket) {
    // The previous interval ended without the bar that closes it.
    closed.push({ ...partial });
    partial = null;
  }
  if (!partial) {
    partial = { t: bucket, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v };
  } else {
    partial.h = Math.max(partial.h, bar.h);
    partial.l = Math.min(partial.l, bar.l);
    partial.c = bar.c;
    partial.v += bar.v;
  }
  if (bar.t + FIVE_MINUTES === bucket + span) {
    closed.push({ ...partial });
    return { partial: null, closedOnBoundary: true };
  }
  return { partial, closedOnBoundary: false };
}
