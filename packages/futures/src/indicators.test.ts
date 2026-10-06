import { rsi } from '@crypto-magic/core';
import { describe, expect, it } from 'vitest';
import { bollinger, median, populationStdev, rsiLastTwo, trailing } from './indicators';
import { barsFromCloses } from './testing/bars';

describe('indicator helpers', () => {
  it('population standard deviation divides by n', () => {
    expect(populationStdev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    expect(populationStdev([])).toBeNaN();
  });

  it('median averages the middle pair for an even count', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('Bollinger bands are SMA ± k population standard deviations', () => {
    const bars = barsFromCloses([2, 4, 4, 4, 5, 5, 7, 9]);
    const bands = bollinger(bars, 7, 8, 2)!;
    expect(bands.middle).toBe(5);
    expect(bands.upper).toBe(9);
    expect(bands.lower).toBe(1);
    expect(bands.bandwidth).toBeCloseTo(8 / 5);
    expect(bollinger(bars, 6, 8, 2)).toBeNull();
  });

  it('RSI comes from the core definition over exactly the window given', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);
    const bars = barsFromCloses(closes);
    const window = trailing(bars, 59, 40)!;
    const expected = rsi(closes.slice(20), 14);
    expect(rsiLastTwo(window, 14)).toEqual([expected[38], expected[39]]);
  });

  it('trailing returns null when the window does not fit', () => {
    const bars = barsFromCloses([1, 2, 3]);
    expect(trailing(bars, 2, 3)).toHaveLength(3);
    expect(trailing(bars, 1, 3)).toBeNull();
  });
});
