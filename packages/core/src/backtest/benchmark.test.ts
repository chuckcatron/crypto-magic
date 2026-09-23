import { describe, expect, it } from 'vitest';
import { candlesFromCloses, randomWalk } from '../testing/synthetic';
import { buyAndHold } from './benchmark';
import { DEFAULT_FEE_MODEL } from './types';

const NO_COST = { takerBps: 0, slippageBps: 0 };

describe('buyAndHold', () => {
  it('tracks the asset exactly when there are no costs', () => {
    // 100 -> 200 is a double.
    const candles = candlesFromCloses([100, 125, 150, 175, 200], { rangePct: 0 });
    const result = buyAndHold({ candles, startIndex: 0, initialEquity: 1000, feeModel: NO_COST });

    // Entry is the FIRST BAR'S OPEN, which candlesFromCloses sets to its own
    // close for bar 0, i.e. 100. Exit is the last close, 200.
    expect(result.totalReturnPct).toBeCloseTo(100, 2);
    expect(result.finalEquity).toBeCloseTo(2000, 2);
  });

  it('loses to costs on a flat market', () => {
    const candles = candlesFromCloses(new Array(50).fill(100), { rangePct: 0 });
    const result = buyAndHold({
      candles,
      startIndex: 0,
      initialEquity: 1000,
      feeModel: DEFAULT_FEE_MODEL,
    });
    expect(result.finalEquity).toBeLessThan(1000);
  });

  it('starts at the strategy warmup bar, so neither side gets a head start', () => {
    // Price doubles during warmup, then stays flat. A benchmark that ignored
    // startIndex would bank that doubling for free and look unbeatable.
    const closes = [...Array.from({ length: 20 }, (_, i) => 100 + i * 5), ...new Array(30).fill(200)];
    const candles = candlesFromCloses(closes, { rangePct: 0 });

    const fromZero = buyAndHold({ candles, startIndex: 0, initialEquity: 1000, feeModel: NO_COST });
    const fromWarmup = buyAndHold({ candles, startIndex: 20, initialEquity: 1000, feeModel: NO_COST });

    expect(fromZero.totalReturnPct).toBeGreaterThan(90);
    // Entering at bar 20's OPEN (which is bar 19's close of 195) and exiting at
    // 200 leaves only the last step of the ramp, not the whole doubling.
    expect(fromWarmup.totalReturnPct).toBeCloseTo(2.56, 1);
    expect(fromWarmup.totalReturnPct).toBeLessThan(fromZero.totalReturnPct / 10);
  });

  it('reports the full peak-to-trough drawdown of the asset', () => {
    // Up to 200, down to 50, back to 150: worst drawdown is 75% from the peak.
    const candles = candlesFromCloses([100, 200, 50, 150], { rangePct: 0 });
    const result = buyAndHold({ candles, startIndex: 0, initialEquity: 1000, feeModel: NO_COST });
    expect(result.maxDrawdownPct).toBeCloseTo(75, 1);
  });

  it('is always fully exposed, by definition', () => {
    const candles = candlesFromCloses(randomWalk(100, { seed: 3 }));
    expect(
      buyAndHold({ candles, startIndex: 0, initialEquity: 1000, feeModel: NO_COST }).exposurePct,
    ).toBe(100);
  });

  it('degrades gracefully on a window too short to measure', () => {
    const candles = candlesFromCloses([100]);
    const result = buyAndHold({ candles, startIndex: 0, initialEquity: 1000, feeModel: NO_COST });
    expect(result.finalEquity).toBe(1000);
    expect(result.totalReturnPct).toBe(0);
  });

  it('pays slippage against itself on both legs', () => {
    const candles = candlesFromCloses([100, 100], { rangePct: 0 });
    const withSlip = buyAndHold({
      candles,
      startIndex: 0,
      initialEquity: 1000,
      feeModel: { takerBps: 0, slippageBps: 100 },
    });
    // Buy 1% high, sell 1% low: roughly 2% worse than break-even.
    expect(withSlip.totalReturnPct).toBeLessThan(-1.9);
  });
});

describe('backtest results carry their benchmark', () => {
  it('exposes buy-and-hold alongside the strategy result', async () => {
    const { runBacktest } = await import('./backtester');
    const { TaEnsembleStrategy } = await import('../strategy/ta-ensemble');
    const { DEFAULT_STOP_CONFIG } = await import('../position/stops');
    const { TEST_PRODUCT } = await import('../testing/synthetic');

    const candles = candlesFromCloses(randomWalk(600, { drift: 0.0008, seed: 5 }));
    const result = runBacktest({
      candles,
      strategy: new TaEnsembleStrategy({
        ...(await import('../strategy/ta-ensemble')).DEFAULT_TA_ENSEMBLE_CONFIG,
        emaTrendPeriod: 50,
      }),
      product: TEST_PRODUCT,
      stopConfig: DEFAULT_STOP_CONFIG,
      initialEquity: 1000,
    });

    expect(result.benchmark.label).toBe('buy & hold');
    // A rising market must show a positive benchmark; if this is ever negative
    // the benchmark is measuring the wrong window.
    expect(result.benchmark.totalReturnPct).toBeGreaterThan(0);
  });
});

describe('fixedAllocation', () => {
  it('at 100% tracks buy-and-hold, and at 0% stays exactly flat', async () => {
    const { fixedAllocation } = await import('./benchmark');
    const candles = candlesFromCloses(randomWalk(400, { drift: 0.002, seed: 9 }), { granularity: 'ONE_DAY' });
    const full = fixedAllocation({ candles, startIndex: 0, fraction: 1, initialEquity: 1000, feeModel: NO_COST });
    const bh = buyAndHold({ candles, startIndex: 0, initialEquity: 1000, feeModel: NO_COST });
    const none = fixedAllocation({ candles, startIndex: 0, fraction: 0, initialEquity: 1000, feeModel: NO_COST });

    expect(full.totalReturnPct).toBeCloseTo(bh.totalReturnPct, 0);
    expect(none.finalEquity).toBe(1000);
    expect(none.maxDrawdownPct).toBe(0);
  });

  it('a smaller BTC share means a smaller drawdown', async () => {
    const { fixedAllocation } = await import('./benchmark');
    const candles = candlesFromCloses(randomWalk(600, { volatility: 0.04, seed: 21 }), { granularity: 'ONE_DAY' });
    const dd = (fraction: number) =>
      fixedAllocation({ candles, startIndex: 0, fraction, initialEquity: 1000, feeModel: NO_COST }).maxDrawdownPct;
    expect(dd(0.1)).toBeLessThan(dd(0.5));
    expect(dd(0.5)).toBeLessThan(dd(1));
  });

  it('pays fees on rebalancing, so a costly version ends below a free one', async () => {
    const { fixedAllocation } = await import('./benchmark');
    const candles = candlesFromCloses(randomWalk(600, { volatility: 0.04, seed: 4 }), { granularity: 'ONE_DAY' });
    const free = fixedAllocation({ candles, startIndex: 0, fraction: 0.3, initialEquity: 1000, feeModel: NO_COST });
    const costly = fixedAllocation({ candles, startIndex: 0, fraction: 0.3, initialEquity: 1000, feeModel: DEFAULT_FEE_MODEL });
    expect(costly.finalEquity).toBeLessThan(free.finalEquity);
  });
});

describe('equalDrawdownAllocation', () => {
  it('finds the BTC share whose drawdown matches the target', async () => {
    const { equalDrawdownAllocation } = await import('./benchmark');
    const candles = candlesFromCloses(randomWalk(800, { volatility: 0.04, seed: 13 }), { granularity: 'ONE_DAY' });
    const result = equalDrawdownAllocation({
      candles, startIndex: 0, targetDrawdownPct: 20, initialEquity: 1000, feeModel: DEFAULT_FEE_MODEL,
    });
    expect(result.maxDrawdownPct).toBeCloseTo(20, 0);
    expect(result.fraction).toBeGreaterThan(0);
    expect(result.fraction).toBeLessThan(1);
  });

  it('caps at 100% when the target is deeper than holding everything', async () => {
    const { equalDrawdownAllocation } = await import('./benchmark');
    const candles = candlesFromCloses(randomWalk(300, { volatility: 0.02, seed: 2 }), { granularity: 'ONE_DAY' });
    const result = equalDrawdownAllocation({
      candles, startIndex: 0, targetDrawdownPct: 99, initialEquity: 1000, feeModel: NO_COST,
    });
    expect(result.fraction).toBe(1);
  });
});

describe('runBacktest tradeFrom', () => {
  it('uses earlier bars only as history: no trade and no benchmark before the start date', async () => {
    const { runBacktest } = await import('./backtester');
    const { RegimeFilterStrategy, REGIME_FILTER_STOP_CONFIG } = await import('../strategy/regime-filter');
    const { TEST_PRODUCT } = await import('../testing/synthetic');

    const closes = Array.from({ length: 300 }, (_, i) => 100 + i); // steady uptrend
    const candles = candlesFromCloses(closes, { granularity: 'ONE_DAY' });
    const tradeFrom = candles[250]!.openTime;

    const result = runBacktest({
      candles,
      strategy: new RegimeFilterStrategy({ smaPeriod: 50, atrPeriod: 14 }),
      product: TEST_PRODUCT,
      stopConfig: REGIME_FILTER_STOP_CONFIG,
      riskLimits: { ...(await import('../risk/limits')).DEFAULT_RISK_LIMITS, maxPositionNotional: 1e9, maxTotalNotional: 1e9, riskPerTradePct: 100 },
      initialEquity: 1000,
      tradeFrom,
    });

    expect(result.startTime).toBe(tradeFrom);
    expect(result.trades.every((t) => t.entryTime >= tradeFrom)).toBe(true);
    // Benchmark measured over the same window: 50 bars of steady gains, not 300.
    const expectedBh = ((closes[299]! - closes[250 - 1]!) / closes[250 - 1]!) * 100;
    expect(result.benchmark.totalReturnPct).toBeLessThan(expectedBh * 1.1);
  });

  it('refuses a start date after the data ends', async () => {
    const { runBacktest } = await import('./backtester');
    const { RegimeFilterStrategy, REGIME_FILTER_STOP_CONFIG } = await import('../strategy/regime-filter');
    const { TEST_PRODUCT } = await import('../testing/synthetic');
    const candles = candlesFromCloses(new Array(100).fill(100), { granularity: 'ONE_DAY' });
    expect(() =>
      runBacktest({
        candles,
        strategy: new RegimeFilterStrategy({ smaPeriod: 20, atrPeriod: 14 }),
        product: TEST_PRODUCT,
        stopConfig: REGIME_FILTER_STOP_CONFIG,
        tradeFrom: candles.at(-1)!.openTime + 86_400 * 10,
      }),
    ).toThrow(/after the last candle/);
  });
});
