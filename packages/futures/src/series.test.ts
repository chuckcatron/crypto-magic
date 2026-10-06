import { describe, expect, it } from 'vitest';
import { MarketSeries } from './series';
import { bar, barsFromCloses, T0 } from './testing/bars';
import { FIVE_MINUTES } from './types';

describe('MarketSeries', () => {
  it('builds 15-minute and 4-hour bars from 5-minute bars', () => {
    const closes = Array.from({ length: 48 }, (_, i) => 100 + i);
    const series = new MarketSeries();
    for (const b of barsFromCloses(closes)) series.append(b);

    expect(series.m15).toHaveLength(16);
    const first = series.m15[0]!;
    expect(first.t).toBe(T0);
    expect(first.o).toBe(100);
    expect(first.c).toBe(102);
    expect(first.h).toBeCloseTo(102 * 1.0005);
    expect(first.l).toBeCloseTo(100 * 0.9995);
    expect(first.v).toBe(30);

    expect(series.h4).toHaveLength(1);
    expect(series.h4[0]!.c).toBe(147);
    expect(series.h4[0]!.v).toBe(480);
  });

  it('flags a bigger bar as closed only on the 5-minute bar that ends its interval', () => {
    const series = new MarketSeries();
    const flags: boolean[] = [];
    for (const b of barsFromCloses([1, 2, 3, 4, 5, 6])) {
      series.append(b);
      flags.push(series.closed15);
    }
    expect(flags).toEqual([false, false, true, false, false, true]);
  });

  it('closes an interval late, without the flag, when its last 5-minute bar is missing', () => {
    const series = new MarketSeries();
    series.append(bar(T0, 1, 2));
    series.append(bar(T0 + FIVE_MINUTES, 2, 3));
    // T0 + 10 minutes had no trades. The next bar opens the next interval.
    series.append(bar(T0 + 3 * FIVE_MINUTES, 3, 4));

    expect(series.m15).toHaveLength(1);
    expect(series.m15[0]!.c).toBe(3);
    expect(series.closed15).toBe(false);
  });

  it('refuses bars out of order or off the 5-minute grid', () => {
    const series = new MarketSeries();
    series.append(bar(T0, 1, 2));
    expect(() => series.append(bar(T0, 1, 2))).toThrow(/ascending/);
    expect(() => series.append(bar(T0 + 60, 1, 2))).toThrow(/boundary/);
  });

  it('trims old bars in batches when given limits', () => {
    const series = new MarketSeries({ m5: 10, m15: 5, h4: 2 });
    // The 1,011th bar takes it past the limit plus the 1,000-bar slack.
    const closes = Array.from({ length: 1011 }, (_, i) => 100 + i);
    for (const b of barsFromCloses(closes)) series.append(b);
    expect(series.m5).toHaveLength(10);
    expect(series.m5.at(-1)!.c).toBe(1110);
    expect(series.now).toBe(T0 + 1011 * FIVE_MINUTES);
  });
});
