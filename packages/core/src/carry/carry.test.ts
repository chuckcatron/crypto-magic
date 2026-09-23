import { describe, expect, it } from 'vitest';
import { EXPERIMENT_002_CONFIG, runCarry, type FundingEvent } from './carry';

const DAY = 86_400;
const series = (rates: number[]): FundingEvent[] =>
  rates.map((rate, i) => ({ time: 1_600_000_000 + i * (DAY / 3), rate }));
const free = { ...EXPERIMENT_002_CONFIG, spotCostBps: 0, perpCostBps: 0 };

describe('runCarry — always on', () => {
  it('earns funding on notional, diluted by the extra capital held as margin', () => {
    // A full year at 0.01% per 8h = 10.95% on notional; on 1.5x capital ≈ 7.3%.
    const result = runCarry(series(new Array(1096).fill(0.0001)), { ...free, mode: 'always' });
    expect(result.grossFundingAnnualizedPct).toBeCloseTo(10.95, 0);
    expect(result.netAnnualizedPct).toBeGreaterThan(7);
    expect(result.netAnnualizedPct).toBeLessThan(7.8);
  });

  it('pays when funding is negative — the short is on the wrong side of it', () => {
    const result = runCarry(series(new Array(300).fill(-0.0002)), { ...free, mode: 'always' });
    expect(result.finalEquity).toBeLessThan(1);
    expect(result.negativeSharePct).toBe(100);
  });

  it('opens and closes exactly once, paying both legs each time', () => {
    const result = runCarry(series(new Array(100).fill(0)), { ...EXPERIMENT_002_CONFIG, mode: 'always' });
    expect(result.switches).toBe(2);
    // 70bps per side on notional (capital / 1.5), twice.
    expect(result.totalCostPct).toBeCloseTo((0.007 / 1.5) * 2 * 100, 1);
  });
});

describe('runCarry — conditional', () => {
  const cfg = { ...free, mode: 'conditional' as const };

  it('stays out until the trailing average clears the entry hurdle', () => {
    // 10% annualized entry = ~0.0000913 per 8h. Below it: never enters.
    const result = runCarry(series(new Array(60).fill(0.00005)), cfg);
    expect(result.switches).toBe(0);
    expect(result.timeInCarryPct).toBe(0);
  });

  it('enters on sustained positive funding and exits once it turns negative', () => {
    const rates = [...new Array(30).fill(0.0003), ...new Array(30).fill(-0.0003)];
    const result = runCarry(series(rates), cfg);
    expect(result.switches).toBe(2);
    expect(result.timeInCarryPct).toBeGreaterThan(20);
    expect(result.timeInCarryPct).toBeLessThan(80);
  });

  it('decides using only payments BEFORE the one being collected', () => {
    // One huge payment with nothing before it must not be collected: the rule
    // cannot know about it until it has happened.
    const rates = [...new Array(9).fill(0), 0.003, ...new Array(9).fill(0)];
    const result = runCarry(series(rates), cfg);
    expect(result.grossFundingAnnualizedPct).toBe(0);
  });
});

describe('runCarry — validation', () => {
  it('rejects out-of-order payments', () => {
    const events = series([0.0001, 0.0001]);
    expect(() => runCarry([events[1]!, events[0]!], { ...free, mode: 'always' })).toThrow(/ascending/);
  });
});
