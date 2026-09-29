import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_CONFIG, openPosition } from '../position/stops';
import { candlesFromCloses } from '../testing/synthetic';
import { REGIME_FILTER_STOP_CONFIG, RegimeFilterStrategy } from './regime-filter';

const strategy = new RegimeFilterStrategy({ smaPeriod: 20, atrPeriod: 14 });
const position = openPosition({
  productId: 'BTC-USD',
  baseSize: 1,
  entryPrice: 100,
  atrValue: 2,
  openedAt: 0,
  config: DEFAULT_STOP_CONFIG,
});

describe('RegimeFilterStrategy', () => {
  it('holds until it has enough history for the average', () => {
    const candles = candlesFromCloses(new Array<number>(10).fill(100));
    expect(strategy.evaluate({ candles, position: null, now: 0 }).action).toBe('HOLD');
  });

  it('enters whenever flat and the close is above the average — no fresh cross needed', () => {
    // Already well above the average: a crossover strategy would wait forever.
    const candles = candlesFromCloses(Array.from({ length: 40 }, (_, i) => 100 + i));
    expect(strategy.evaluate({ candles, position: null, now: 0 }).action).toBe('ENTER_LONG');
  });

  it('stays out while the close is below the average', () => {
    const candles = candlesFromCloses(Array.from({ length: 40 }, (_, i) => 200 - i));
    expect(strategy.evaluate({ candles, position: null, now: 0 }).action).toBe('HOLD');
  });

  it('holds an open position through volatility while the regime stays up', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i + (i % 2 === 0 ? 3 : -3));
    const candles = candlesFromCloses(closes);
    expect(strategy.evaluate({ candles, position, now: 0 }).action).toBe('HOLD');
  });

  it('exits when the close falls below the average', () => {
    const closes = [...Array.from({ length: 30 }, (_, i) => 100 + i), 90, 80, 70];
    const candles = candlesFromCloses(closes);
    const signal = strategy.evaluate({ candles, position, now: 0 });
    expect(signal.action).toBe('EXIT_LONG');
    expect(signal.reasons[0]).toMatch(/fell below SMA20/);
  });

  it('never sets a target, a trail or a holding limit — only a distant disaster stop', () => {
    expect(REGIME_FILTER_STOP_CONFIG.atrTakeProfitMultiple).toBeNull();
    expect(REGIME_FILTER_STOP_CONFIG.trailingEnabled).toBe(false);
    expect(REGIME_FILTER_STOP_CONFIG.maxHoldingBars).toBeNull();
    expect(REGIME_FILTER_STOP_CONFIG.atrStopMultiple).toBe(10);
  });

  it('names itself after its period so reports are unambiguous', () => {
    expect(new RegimeFilterStrategy().name).toBe('regime-sma200');
  });

  it('rejects a nonsense period', () => {
    expect(() => new RegimeFilterStrategy({ smaPeriod: 1, atrPeriod: 14 })).toThrow(RangeError);
  });

  describe('with a faster exit line', () => {
    const dual = new RegimeFilterStrategy({ smaPeriod: 20, atrPeriod: 14, exitSmaPeriod: 5 });
    // A steady climb, then a sharp one-day drop that stays above the slow line.
    const pullback = [...Array.from({ length: 30 }, (_, i) => 100 + 2 * i), 145];

    it('exits when the close falls below the fast line, even above the slow one', () => {
      const signal = dual.evaluate({ candles: candlesFromCloses(pullback), position, now: 0 });
      expect(signal.action).toBe('EXIT_LONG');
      expect(signal.reasons[0]).toMatch(/fell below SMA5/);
      // Still above the slow line: plain regime-sma20 would keep holding.
      expect(
        strategy.evaluate({ candles: candlesFromCloses(pullback), position, now: 0 }).action,
      ).toBe('HOLD');
    });

    it('does not buy back while the close is under the fast line', () => {
      const signal = dual.evaluate({
        candles: candlesFromCloses(pullback),
        position: null,
        now: 0,
      });
      expect(signal.action).toBe('HOLD');
    });

    it('enters only when the close is above both lines', () => {
      const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
      const signal = dual.evaluate({ candles: candlesFromCloses(rising), position: null, now: 0 });
      expect(signal.action).toBe('ENTER_LONG');
      expect(signal.reasons[0]).toMatch(/above SMA20 .* and SMA5/);
    });

    it('names itself after both lines, and needs the exit line to be the faster one', () => {
      expect(dual.name).toBe('regime-sma20-exit5');
      expect(
        () => new RegimeFilterStrategy({ smaPeriod: 20, atrPeriod: 14, exitSmaPeriod: 20 }),
      ).toThrow(RangeError);
    });
  });
});
