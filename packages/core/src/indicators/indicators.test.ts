import { describe, expect, it } from 'vitest';
import { atr, crossedAbove, crossedBelow, ema, rsi, sma, trueRange } from './index';
import type { Candle } from '../types/market';

const bar = (high: number, low: number, close: number, i = 0): Candle => ({
  productId: 'BTC-USD',
  granularity: 'ONE_HOUR',
  openTime: 1_700_000_000 + i * 3600,
  open: close,
  high,
  low,
  close,
  volume: 1,
});

describe('sma', () => {
  it('is undefined during warmup and correct after', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it('returns all undefined when there is not enough data', () => {
    expect(sma([1, 2], 5)).toEqual([undefined, undefined]);
  });

  it('rejects a nonsense period', () => {
    expect(() => sma([1, 2, 3], 0)).toThrow(RangeError);
  });
});

describe('ema', () => {
  it('seeds from the SMA and then applies the smoothing factor', () => {
    // seed = (1+2+3)/3 = 2 at index 2; k = 2/(3+1) = 0.5
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it('tracks a constant series exactly', () => {
    const out = ema([7, 7, 7, 7, 7, 7], 3);
    expect(out.slice(2)).toEqual([7, 7, 7, 7]);
  });

  it('reacts faster than the SMA of the same period', () => {
    const values = [10, 10, 10, 10, 20];
    const e = ema(values, 4).at(-1)!;
    const s = sma(values, 4).at(-1)!;
    expect(e).toBeGreaterThan(s);
  });
});

describe('rsi', () => {
  it('pins to 100 when every period is a gain', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(rising, 14).at(-1)).toBe(100);
  });

  it('pins to 0 when every period is a loss', () => {
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(falling, 14).at(-1)).toBe(0);
  });

  it('returns 50 for a perfectly flat series rather than dividing by zero', () => {
    const flat = new Array(30).fill(100);
    expect(rsi(flat, 14).at(-1)).toBe(50);
  });

  it('matches a hand-computed case', () => {
    // period 2 over [1,2,1]: avgGain = 0.5, avgLoss = 0.5 -> RS 1 -> RSI 50
    expect(rsi([1, 2, 1], 2)[2]).toBe(50);
  });

  it('does not emit a value before it has period+1 samples', () => {
    const out = rsi([1, 2, 3, 4], 14);
    expect(out.every((v) => v === undefined)).toBe(true);
  });
});

describe('trueRange', () => {
  it('uses the prior close when it gaps outside the current bar', () => {
    const candles = [bar(10, 9, 10, 0), bar(20, 19, 20, 1)];
    // bar 1 gapped up from a close of 10: |high - prevClose| = 10 beats high-low = 1
    expect(trueRange(candles)[1]).toBe(10);
  });
});

describe('atr', () => {
  it('converges to the constant range of a steady series', () => {
    const candles = Array.from({ length: 40 }, (_, i) => bar(102, 100, 101, i));
    expect(atr(candles, 14).at(-1)).toBeCloseTo(2, 6);
  });

  it('stays undefined until it has period+1 bars', () => {
    const candles = Array.from({ length: 10 }, (_, i) => bar(102, 100, 101, i));
    expect(atr(candles, 14).every((v) => v === undefined)).toBe(true);
  });
});

describe('crossovers', () => {
  it('detects a fast line crossing up through a slow line', () => {
    expect(crossedAbove([1, 3], [2, 2], 1)).toBe(true);
    expect(crossedBelow([1, 3], [2, 2], 1)).toBe(false);
  });

  it('detects a fast line crossing down through a slow line', () => {
    expect(crossedBelow([3, 1], [2, 2], 1)).toBe(true);
  });

  it('does not fire when the lines merely touch without crossing', () => {
    expect(crossedAbove([1, 2], [2, 2], 1)).toBe(false);
  });

  it('never fires during warmup', () => {
    expect(crossedAbove([undefined, 3], [undefined, 2], 1)).toBe(false);
    expect(crossedAbove([1, 3], [2, 2], 0)).toBe(false);
  });
});
