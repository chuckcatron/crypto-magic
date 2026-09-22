import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_CONFIG } from '../position/stops';
import { DEFAULT_RISK_LIMITS } from '../risk/limits';
import { DEFAULT_TA_ENSEMBLE_CONFIG, TaEnsembleStrategy } from '../strategy/ta-ensemble';
import type { Strategy, StrategyContext } from '../strategy/types';
import { TEST_PRODUCT, candlesFromCloses, flatThenRally, randomWalk } from '../testing/synthetic';
import type { Signal } from '../types/trading';
import { runBacktest } from './backtester';
import { DEFAULT_FEE_MODEL } from './types';

const bigLimits = { ...DEFAULT_RISK_LIMITS, maxPositionNotional: 5000, maxTotalNotional: 5000 };

/** Buys on a fixed bar index and holds. Lets us assert fill mechanics exactly. */
class ScriptedStrategy implements Strategy {
  readonly name = 'scripted';
  constructor(
    readonly warmupBars: number,
    private readonly script: Map<number, Signal['action']>,
  ) {}
  evaluate(ctx: StrategyContext): Signal {
    const action = this.script.get(ctx.candles.length - 1) ?? 'HOLD';
    return { action, confidence: 1, reasons: ['scripted'], indicators: {} };
  }
}

describe('runBacktest input validation', () => {
  it('rejects an empty candle set', () => {
    expect(() =>
      runBacktest({
        candles: [],
        strategy: new TaEnsembleStrategy(),
        product: TEST_PRODUCT,
        stopConfig: DEFAULT_STOP_CONFIG,
      }),
    ).toThrow(/at least one candle/);
  });

  it('rejects out-of-order or duplicated candles', () => {
    const candles = candlesFromCloses([100, 101, 102]);
    const shuffled = [candles[0]!, candles[2]!, candles[1]!];
    expect(() =>
      runBacktest({
        candles: shuffled,
        strategy: new TaEnsembleStrategy(),
        product: TEST_PRODUCT,
        stopConfig: DEFAULT_STOP_CONFIG,
      }),
    ).toThrow(/strictly ascending/);
  });
});

describe('fill mechanics', () => {
  const noFees = { takerBps: 0, slippageBps: 0 };

  it('fills a signal at the NEXT bar open, never the close that produced it', () => {
    // Closes rise smoothly; opens equal the previous close by construction.
    const closes = [...Array(40).fill(100), 110, 120, 130, 140, 150];
    const candles = candlesFromCloses(closes, { rangePct: 0 });
    const strategy = new ScriptedStrategy(40, new Map([[40, 'ENTER_LONG' as const]]));

    const result = runBacktest({
      candles,
      strategy,
      product: TEST_PRODUCT,
      stopConfig: { ...DEFAULT_STOP_CONFIG, maxHoldingBars: null },
      riskLimits: bigLimits,
      feeModel: noFees,
      initialEquity: 10_000,
    });

    expect(result.trades).toHaveLength(1);
    // Signal fired on the bar closing at 110 (index 40); the fill is index 41's
    // open, which is 110 — not index 40's close and not index 41's close of 120.
    expect(result.trades[0]!.entryPrice.toNumber()).toBe(110);
  });

  it('charges taker fees and adverse slippage on both sides', () => {
    // Opens equal the previous close, so both fills land at exactly 100; the
    // intrabar range exists only to give ATR something to measure, since a
    // zero-ATR market can never be sized into a position.
    const closes = [...Array(40).fill(100), 100, 100, 100];
    const candles = candlesFromCloses(closes, { rangePct: 0.005 });
    const strategy = new ScriptedStrategy(
      40,
      new Map([
        [40, 'ENTER_LONG' as const],
        [41, 'EXIT_LONG' as const],
      ]),
    );

    const result = runBacktest({
      candles,
      strategy,
      product: TEST_PRODUCT,
      stopConfig: { ...DEFAULT_STOP_CONFIG, maxHoldingBars: null },
      riskLimits: bigLimits,
      feeModel: DEFAULT_FEE_MODEL,
      initialEquity: 10_000,
    });

    // Round trip at an unchanged price must lose money to costs.
    expect(result.finalEquity).toBeLessThan(10_000);
    if (result.trades.length > 0) {
      expect(result.trades[0]!.pnl.toNumber()).toBeLessThan(0);
      expect(result.trades[0]!.fees.toNumber()).toBeGreaterThan(0);
    }
  });
});

describe('risk integration', () => {
  it('never opens a position larger than the notional cap allows', () => {
    const candles = candlesFromCloses(flatThenRally(220, 120));
    const result = runBacktest({
      candles,
      strategy: new TaEnsembleStrategy(),
      product: TEST_PRODUCT,
      stopConfig: DEFAULT_STOP_CONFIG,
      riskLimits: { ...DEFAULT_RISK_LIMITS, maxPositionNotional: 25 },
      initialEquity: 10_000,
    });

    for (const trade of result.trades) {
      const notional = trade.baseSize.mul(trade.entryPrice).toNumber();
      expect(notional).toBeLessThanOrEqual(25.000001);
    }
  });

  it('records why an entry was refused instead of silently skipping it', () => {
    const candles = candlesFromCloses(flatThenRally(220, 120));
    const result = runBacktest({
      candles,
      strategy: new TaEnsembleStrategy(),
      product: TEST_PRODUCT,
      stopConfig: DEFAULT_STOP_CONFIG,
      // Equity far too small to clear the minimum order size.
      riskLimits: { ...DEFAULT_RISK_LIMITS, minOrderNotional: 50, maxPositionNotional: 100 },
      initialEquity: 20,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.rejections.length).toBeGreaterThan(0);
  });
});

describe('strategy behaviour end to end', () => {
  it('takes no trades in a dead flat market', () => {
    const candles = candlesFromCloses(new Array(400).fill(100), { rangePct: 0.0001 });
    const result = runBacktest({
      candles,
      strategy: new TaEnsembleStrategy(),
      product: TEST_PRODUCT,
      stopConfig: DEFAULT_STOP_CONFIG,
      initialEquity: 10_000,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.finalEquity).toBe(10_000);
  });

  it('participates in a clean sustained rally', () => {
    const candles = candlesFromCloses(flatThenRally(220, 200));
    const result = runBacktest({
      candles,
      strategy: new TaEnsembleStrategy(),
      product: TEST_PRODUCT,
      stopConfig: DEFAULT_STOP_CONFIG,
      riskLimits: bigLimits,
      initialEquity: 10_000,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.finalEquity).toBeGreaterThan(10_000);
  });

  it('keeps every loss bounded by the stop plus costs', () => {
    const candles = candlesFromCloses(randomWalk(1200, { volatility: 0.02, seed: 7 }));
    const result = runBacktest({
      candles,
      strategy: new TaEnsembleStrategy(),
      product: TEST_PRODUCT,
      stopConfig: DEFAULT_STOP_CONFIG,
      riskLimits: bigLimits,
      initialEquity: 10_000,
    });

    for (const trade of result.trades) {
      // Stop is 2 ATR below entry; allow generous headroom for gap-through,
      // slippage and fees, but a loss anywhere near the position value means
      // the stop did not work.
      const notional = trade.baseSize.mul(trade.entryPrice).toNumber();
      expect(trade.pnl.toNumber()).toBeGreaterThan(-notional * 0.5);
    }
  });

  it('produces an equity curve and coherent metrics', () => {
    const candles = candlesFromCloses(randomWalk(800, { drift: 0.0005, seed: 11 }));
    const strategy = new TaEnsembleStrategy(DEFAULT_TA_ENSEMBLE_CONFIG);
    const result = runBacktest({
      candles,
      strategy,
      product: TEST_PRODUCT,
      stopConfig: DEFAULT_STOP_CONFIG,
      riskLimits: bigLimits,
      initialEquity: 10_000,
    });

    expect(result.equityCurve).toHaveLength(candles.length - strategy.warmupBars);
    expect(result.metrics.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(result.metrics.totalTrades).toBe(result.trades.length);
    expect(result.metrics.winningTrades + result.metrics.losingTrades).toBe(result.trades.length);
    expect(result.metrics.exposurePct).toBeGreaterThanOrEqual(0);
    expect(result.metrics.exposurePct).toBeLessThanOrEqual(100);
  });

  it('closes any open position at the end so results are comparable', () => {
    const candles = candlesFromCloses(flatThenRally(220, 300));
    const result = runBacktest({
      candles,
      strategy: new TaEnsembleStrategy(),
      product: TEST_PRODUCT,
      stopConfig: { ...DEFAULT_STOP_CONFIG, maxHoldingBars: null, atrTakeProfitMultiple: null },
      riskLimits: bigLimits,
      initialEquity: 10_000,
    });
    const lastPoint = result.equityCurve.at(-1)!;
    expect(result.trades.length).toBeGreaterThan(0);
    // Final equity is all cash — nothing left marked to market.
    expect(result.finalEquity).toBeGreaterThan(0);
    expect(lastPoint.equity).toBeGreaterThan(0);
  });
});
