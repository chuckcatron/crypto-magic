import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_CONFIG, openPosition } from '../position/stops';
import { candlesFromCloses, flatThenRally } from '../testing/synthetic';
import { DEFAULT_TA_ENSEMBLE_CONFIG, TaEnsembleStrategy, type TaEnsembleConfig } from './ta-ensemble';

const fastConfig: TaEnsembleConfig = {
  ...DEFAULT_TA_ENSEMBLE_CONFIG,
  emaTrendPeriod: 50,
  requireTrendFilter: true,
};

const heldPosition = openPosition({
  productId: 'BTC-USD',
  baseSize: 1,
  entryPrice: 100,
  atrValue: 2,
  openedAt: 0,
  config: DEFAULT_STOP_CONFIG,
});

describe('config validation', () => {
  it('rejects a fast EMA that is not faster than the slow one', () => {
    expect(() => new TaEnsembleStrategy({ ...DEFAULT_TA_ENSEMBLE_CONFIG, emaFastPeriod: 30 })).toThrow(
      /emaFastPeriod/,
    );
  });

  it('rejects an inverted RSI band', () => {
    expect(
      () => new TaEnsembleStrategy({ ...DEFAULT_TA_ENSEMBLE_CONFIG, rsiEntryMin: 90 }),
    ).toThrow(/rsiEntryMin/);
  });

  it('rejects an inverted volatility band', () => {
    expect(() => new TaEnsembleStrategy({ ...DEFAULT_TA_ENSEMBLE_CONFIG, minAtrPct: 20 })).toThrow(
      /minAtrPct/,
    );
  });

  it('looks back far enough for the longest EMA to shed its seed', () => {
    const strategy = new TaEnsembleStrategy(DEFAULT_TA_ENSEMBLE_CONFIG);
    expect(strategy.lookbackBars).toBe(201 + 3 * 200);
    // Seed weight after 3 periods for EMA(200): well under half a percent.
    expect((1 - 2 / 201) ** 600).toBeLessThan(0.005);
  });

  it('derives warmup from the longest indicator it uses', () => {
    expect(new TaEnsembleStrategy(DEFAULT_TA_ENSEMBLE_CONFIG).warmupBars).toBe(201);
    expect(
      new TaEnsembleStrategy({ ...DEFAULT_TA_ENSEMBLE_CONFIG, requireTrendFilter: false }).warmupBars,
    ).toBe(27);
  });
});

describe('warmup', () => {
  it('holds while there is not enough history, whatever the price does', () => {
    const strategy = new TaEnsembleStrategy(fastConfig);
    const candles = candlesFromCloses(flatThenRally(10, 10));
    expect(strategy.evaluate({ candles, position: null, now: 0 }).action).toBe('HOLD');
  });
});

describe('entries', () => {
  it('enters on a clean cross inside a healthy uptrend', () => {
    const strategy = new TaEnsembleStrategy(fastConfig);
    const closes = flatThenRally(120, 40);
    const candles = candlesFromCloses(closes);

    const actions = candles
      .map((_, i) =>
        i < strategy.warmupBars
          ? 'HOLD'
          : strategy.evaluate({ candles: candles.slice(0, i + 1), position: null, now: 0 }).action,
      )
      .filter((a) => a === 'ENTER_LONG');

    expect(actions.length).toBeGreaterThan(0);
  });

  it('vetoes an otherwise valid cross that happens below the trend EMA', () => {
    const withFilter = new TaEnsembleStrategy(fastConfig);
    const withoutFilter = new TaEnsembleStrategy({ ...fastConfig, requireTrendFilter: false });

    // A long decline with a brief bounce: crosses happen, but always under trend.
    const closes = [
      ...Array.from({ length: 120 }, (_, i) => 200 - i * 0.8),
      ...Array.from({ length: 15 }, (_, i) => 104 + i * 0.5),
    ];
    const candles = candlesFromCloses(closes);

    const countEntries = (s: TaEnsembleStrategy) =>
      candles.filter(
        (_, i) =>
          i >= s.warmupBars &&
          s.evaluate({ candles: candles.slice(0, i + 1), position: null, now: 0 }).action ===
            'ENTER_LONG',
      ).length;

    expect(countEntries(withFilter)).toBeLessThanOrEqual(countEntries(withoutFilter));
  });

  it('explains itself on every decision', () => {
    const strategy = new TaEnsembleStrategy(fastConfig);
    const candles = candlesFromCloses(flatThenRally(120, 40));
    const signal = strategy.evaluate({ candles, position: null, now: 0 });
    expect(signal.indicators.rsi).not.toBeNull();
    expect(signal.indicators.atr).not.toBeNull();
    expect(signal.indicators.emaFast).not.toBeNull();
    expect(signal.confidence).toBeGreaterThanOrEqual(0);
    expect(signal.confidence).toBeLessThanOrEqual(1);
  });

  it('refuses to enter a market too quiet to cover fees', () => {
    const strategy = new TaEnsembleStrategy({ ...fastConfig, minAtrPct: 5 });
    const candles = candlesFromCloses(flatThenRally(120, 40));
    for (let i = strategy.warmupBars; i < candles.length; i++) {
      const signal = strategy.evaluate({ candles: candles.slice(0, i + 1), position: null, now: 0 });
      expect(signal.action).not.toBe('ENTER_LONG');
    }
  });

  it('refuses to enter a market too violent to stop sensibly', () => {
    const strategy = new TaEnsembleStrategy({ ...fastConfig, maxAtrPct: 0.001, minAtrPct: 0.0001 });
    const candles = candlesFromCloses(flatThenRally(120, 40));
    for (let i = strategy.warmupBars; i < candles.length; i++) {
      expect(
        strategy.evaluate({ candles: candles.slice(0, i + 1), position: null, now: 0 }).action,
      ).not.toBe('ENTER_LONG');
    }
  });
});

describe('exits', () => {
  it('never returns ENTER_LONG while a position is open', () => {
    const strategy = new TaEnsembleStrategy(fastConfig);
    const candles = candlesFromCloses(flatThenRally(120, 60));
    for (let i = strategy.warmupBars; i < candles.length; i++) {
      const signal = strategy.evaluate({
        candles: candles.slice(0, i + 1),
        position: heldPosition,
        now: 0,
      });
      expect(signal.action).not.toBe('ENTER_LONG');
    }
  });

  it('exits when the trend rolls over', () => {
    const strategy = new TaEnsembleStrategy(fastConfig);
    const closes = [...flatThenRally(120, 40), ...Array.from({ length: 40 }, (_, i) => 116 - i * 1.5)];
    const candles = candlesFromCloses(closes);

    const exits = candles.filter(
      (_, i) =>
        i >= strategy.warmupBars &&
        strategy.evaluate({ candles: candles.slice(0, i + 1), position: heldPosition, now: 0 })
          .action === 'EXIT_LONG',
    );
    expect(exits.length).toBeGreaterThan(0);
  });

  it('exits on a blow-off top even without a cross', () => {
    const strategy = new TaEnsembleStrategy({ ...fastConfig, rsiExitMax: 70 });
    const closes = [...Array(120).fill(100), ...Array.from({ length: 30 }, (_, i) => 100 * 1.03 ** (i + 1))];
    const candles = candlesFromCloses(closes);
    const signal = strategy.evaluate({ candles, position: heldPosition, now: 0 });
    expect(signal.action).toBe('EXIT_LONG');
    expect(signal.reasons.some((r) => /blow-off/.test(r))).toBe(true);
  });
});
