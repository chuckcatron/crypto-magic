import { describe, expect, it } from 'vitest';
import { D } from '../money';
import { openPosition, DEFAULT_STOP_CONFIG } from '../position/stops';
import type { ProductSpec } from '../types/market';
import type { OrderIntent, Position } from '../types/trading';
import { DEFAULT_RISK_LIMITS, validateRiskLimits, type RiskLimits } from './limits';
import { sizePosition } from './position-sizer';
import { RiskEngine, type RiskState } from './risk-engine';

const product: ProductSpec = {
  productId: 'BTC-USD',
  baseCurrency: 'BTC',
  quoteCurrency: 'USD',
  baseIncrement: '0.00000001',
  quoteIncrement: '0.01',
  minMarketFunds: '1',
  tradingDisabled: false,
};

const limits: RiskLimits = { ...DEFAULT_RISK_LIMITS };

const baseState: RiskState = {
  equity: 1000,
  availableQuote: 1000,
  openPositions: [],
  realizedPnlToday: 0,
  consecutiveLosses: 0,
  ordersLastHour: 0,
  killSwitchEngaged: false,
  marketDataAgeSeconds: 5,
  maxMarketDataAgeSeconds: 120,
};

const buy = (baseSize: number, price = 100): OrderIntent => ({
  productId: 'BTC-USD',
  side: 'BUY',
  baseSize: D(baseSize),
  referencePrice: D(price),
  reason: 'test',
  idempotencyKey: 'k1',
});

const sell = (baseSize: number, price = 100): OrderIntent => ({
  productId: 'BTC-USD',
  side: 'SELL',
  baseSize: D(baseSize),
  referencePrice: D(price),
  reason: 'test',
  exitReason: 'signal',
  idempotencyKey: 'k2',
});

const heldPosition = (baseSize: number): Position =>
  openPosition({
    productId: 'BTC-USD',
    baseSize,
    entryPrice: 100,
    atrValue: 5,
    openedAt: 0,
    config: DEFAULT_STOP_CONFIG,
  });

describe('validateRiskLimits', () => {
  it('accepts the shipped defaults', () => {
    expect(() => validateRiskLimits(DEFAULT_RISK_LIMITS)).not.toThrow();
  });

  it('rejects a per-position cap larger than the total cap', () => {
    expect(() =>
      validateRiskLimits({ ...limits, maxPositionNotional: 500, maxTotalNotional: 100 }),
    ).toThrow(/cannot exceed maxTotalNotional/);
  });

  it('rejects a minimum order larger than the position cap', () => {
    expect(() => validateRiskLimits({ ...limits, minOrderNotional: 50, maxPositionNotional: 25 })).toThrow(
      /no order could ever pass/,
    );
  });

  it('rejects risking more than the whole account per trade', () => {
    expect(() => validateRiskLimits({ ...limits, riskPerTradePct: 150 })).toThrow(/riskPerTradePct/);
  });
});

describe('sizePosition', () => {
  it('sizes from the distance to the stop', () => {
    // 1% of 1000 = 10 risk budget, full confidence, 10 wide stop -> 1 unit,
    // then capped to 25 notional / 100 = 0.25 units.
    const result = sizePosition({
      equity: 1000,
      availableQuote: 1000,
      entryPrice: 100,
      stopPrice: 90,
      openNotional: 0,
      product,
      limits,
      confidence: 1,
    });
    expect(result.rejected).toBeNull();
    expect(result.baseSize.toNumber()).toBe(0.25);
    expect(result.constraints).toContain('capped by maxPositionNotional');
  });

  it('buys more units when the stop is tighter, for the same dollar risk', () => {
    const wide = sizePosition({
      equity: 1000, availableQuote: 1000, entryPrice: 100, stopPrice: 90,
      openNotional: 0, product, limits: { ...limits, maxPositionNotional: 1000, maxTotalNotional: 1000 }, confidence: 1,
    });
    const tight = sizePosition({
      equity: 1000, availableQuote: 1000, entryPrice: 100, stopPrice: 98,
      openNotional: 0, product, limits: { ...limits, maxPositionNotional: 1000, maxTotalNotional: 1000 }, confidence: 1,
    });
    expect(tight.baseSize.toNumber()).toBeGreaterThan(wide.baseSize.toNumber());
    // Both risk ~10 dollars to the stop.
    expect(wide.baseSize.mul(10).toNumber()).toBeCloseTo(10, 6);
    expect(tight.baseSize.mul(2).toNumber()).toBeCloseTo(10, 6);
  });

  it('scales down with low confidence but never up', () => {
    const args = {
      equity: 1000, availableQuote: 1000, entryPrice: 100, stopPrice: 90, openNotional: 0,
      product, limits: { ...limits, maxPositionNotional: 1000, maxTotalNotional: 1000 },
    };
    const weak = sizePosition({ ...args, confidence: 0 });
    const strong = sizePosition({ ...args, confidence: 1 });
    expect(weak.baseSize.toNumber()).toBeCloseTo(strong.baseSize.toNumber() / 2, 8);
  });

  it('respects the remaining total notional budget', () => {
    const result = sizePosition({
      equity: 1000, availableQuote: 1000, entryPrice: 100, stopPrice: 90,
      openNotional: 90, product, limits, confidence: 1,
    });
    expect(result.baseSize.mul(100).toNumber()).toBeLessThanOrEqual(10);
    expect(result.constraints).toContain('capped by maxTotalNotional');
  });

  it('refuses when the total notional cap is already spent', () => {
    const result = sizePosition({
      equity: 1000, availableQuote: 1000, entryPrice: 100, stopPrice: 90,
      openNotional: 100, product, limits, confidence: 1,
    });
    expect(result.rejected).toMatch(/total notional cap already used/);
  });

  it('refuses a stop that is not below entry', () => {
    const result = sizePosition({
      equity: 1000, availableQuote: 1000, entryPrice: 100, stopPrice: 100,
      openNotional: 0, product, limits, confidence: 1,
    });
    expect(result.rejected).toMatch(/stop price must be below entry/);
  });

  it('refuses a dust order below the exchange minimum', () => {
    const result = sizePosition({
      equity: 10, availableQuote: 10, entryPrice: 100, stopPrice: 90,
      openNotional: 0, product, limits: { ...limits, minOrderNotional: 5 }, confidence: 1,
    });
    expect(result.rejected).toMatch(/below exchange minimum/);
  });

  it('refuses a product that is not tradable', () => {
    const result = sizePosition({
      equity: 1000, availableQuote: 1000, entryPrice: 100, stopPrice: 90,
      openNotional: 0, product: { ...product, tradingDisabled: true }, limits, confidence: 1,
    });
    expect(result.rejected).toMatch(/trading disabled/);
  });

  it('rounds the size down to the exchange increment, never up', () => {
    const coarse: ProductSpec = { ...product, baseIncrement: '0.1' };
    const result = sizePosition({
      equity: 1000, availableQuote: 1000, entryPrice: 100, stopPrice: 90,
      openNotional: 0, product: coarse, limits, confidence: 1,
    });
    expect(result.baseSize.toNumber()).toBe(0.2); // 0.25 floored to 0.1
  });
});

describe('RiskEngine halts', () => {
  const engine = new RiskEngine(limits);

  it('is clean in the happy state', () => {
    expect(engine.haltReasons(baseState)).toEqual([]);
  });

  it('halts on the kill switch', () => {
    expect(engine.haltReasons({ ...baseState, killSwitchEngaged: true })).toContain('kill_switch');
  });

  it('halts at the daily loss limit', () => {
    expect(engine.haltReasons({ ...baseState, realizedPnlToday: -10 })).toContain('daily_loss_limit');
  });

  it('halts after too many losses in a row', () => {
    expect(engine.haltReasons({ ...baseState, consecutiveLosses: 4 })).toContain('consecutive_losses');
  });

  it('halts when the order rate limit is reached', () => {
    expect(engine.haltReasons({ ...baseState, ordersLastHour: 12 })).toContain('order_rate_limit');
  });

  it('halts on stale market data rather than trading a guessed price', () => {
    expect(engine.haltReasons({ ...baseState, marketDataAgeSeconds: 300 })).toContain(
      'stale_market_data',
    );
  });
});

describe('RiskEngine.assess', () => {
  const engine = new RiskEngine(limits);

  it('approves an entry inside every cap', () => {
    const decision = engine.assess(buy(0.2), baseState);
    expect(decision.approved).toBe(true);
    expect(decision.rejections).toEqual([]);
  });

  it('rejects an entry above the per-position notional cap', () => {
    const decision = engine.assess(buy(0.5), baseState); // 50 > 25
    expect(decision.approved).toBe(false);
    expect(decision.rejections.some((r) => /per-position cap/.test(r))).toBe(true);
  });

  it('rejects an entry while the kill switch is engaged', () => {
    const decision = engine.assess(buy(0.2), { ...baseState, killSwitchEngaged: true });
    expect(decision.approved).toBe(false);
    expect(decision.rejections).toContain('trading halted: kill_switch');
  });

  it('refuses to scale into a product it already holds', () => {
    const decision = engine.assess(buy(0.1), {
      ...baseState,
      openPositions: [heldPosition(0.1)],
    });
    expect(decision.approved).toBe(false);
    expect(decision.rejections.some((r) => /does not scale in/.test(r))).toBe(true);
  });

  it('rejects an entry beyond the open position count', () => {
    const others = ['ETH-USD', 'SOL-USD', 'LTC-USD', 'DOGE-USD'].map((id) => ({
      ...heldPosition(0.01),
      productId: id,
    }));
    const decision = engine.assess(buy(0.1), { ...baseState, openPositions: others });
    expect(decision.rejections.some((r) => /at cap 4/.test(r))).toBe(true);
  });

  it('rejects an entry the account cannot pay for', () => {
    const decision = engine.assess(buy(0.2), { ...baseState, availableQuote: 5 });
    expect(decision.rejections.some((r) => /exceeds available quote/.test(r))).toBe(true);
  });

  it('ALWAYS allows an exit, even with the kill switch engaged', () => {
    const decision = engine.assess(sell(0.1), {
      ...baseState,
      killSwitchEngaged: true,
      realizedPnlToday: -999,
      consecutiveLosses: 99,
      ordersLastHour: 999,
      openPositions: [heldPosition(0.1)],
    });
    expect(decision.approved).toBe(true);
  });

  it('clamps an oversized exit to what is actually held', () => {
    const decision = engine.assess(sell(5), { ...baseState, openPositions: [heldPosition(0.1)] });
    expect(decision.approved).toBe(true);
    expect(decision.adjustedBaseSize?.toNumber()).toBe(0.1);
    expect(decision.warnings[0]).toMatch(/reduced to holdings/);
  });

  it('rejects selling something we do not hold', () => {
    const decision = engine.assess(sell(0.1), baseState);
    expect(decision.approved).toBe(false);
  });

  it('warns when the daily loss budget is nearly exhausted', () => {
    const decision = engine.assess(buy(0.2), { ...baseState, realizedPnlToday: -8 });
    expect(decision.warnings.some((w) => /daily loss budget/.test(w))).toBe(true);
  });
});

describe('RiskEngine.checkSlippage', () => {
  const engine = new RiskEngine(limits);

  it('accepts a fill within tolerance', () => {
    expect(engine.checkSlippage(100, 100.2)).toEqual({ ok: true, pct: 0.2 });
  });

  it('rejects a fill outside tolerance in either direction', () => {
    expect(engine.checkSlippage(100, 101).ok).toBe(false);
    expect(engine.checkSlippage(100, 99).ok).toBe(false);
  });
});
