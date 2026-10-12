import { describe, expect, it } from 'vitest';
import type { ClosedTrade } from '../types';
import { between, performance, poolReturns, returnsFromMarks, tradeStats } from './metrics';

const D = 86_400;

describe('metrics', () => {
  it('turns end-of-day equity into daily returns from the starting equity', () => {
    const returns = returnsFromMarks(
      [
        { day: D, equity: 110 },
        { day: 2 * D, equity: 99 },
      ],
      100,
    );
    expect(returns.map((r) => r.r)).toEqual([0.10000000000000009, -0.09999999999999998]);
  });

  it('pools sub-accounts by averaging the ones trading each day', () => {
    const pooled = poolReturns([
      [
        { day: D, r: 0.02 },
        { day: 2 * D, r: 0.04 },
      ],
      [{ day: 2 * D, r: 0 }],
    ]);
    expect(pooled).toEqual([
      { day: D, r: 0.02 },
      { day: 2 * D, r: 0.02 },
    ]);
  });

  it('measures compounded return, annualization, drawdown and the t-statistic', () => {
    const perf = performance([
      { day: D, r: 0.1 },
      { day: 2 * D, r: -0.1 },
    ]);
    expect(perf.totalReturn).toBeCloseTo(-0.01);
    expect(perf.annualized).toBeCloseTo(0.99 ** (365 / 2) - 1);
    expect(perf.maxDrawdown).toBeCloseTo(0.1);
    expect(perf.tStat).toBeCloseTo(0);

    const steady = performance(
      Array.from({ length: 365 }, (_, i) => ({ day: i * D, r: i % 2 === 0 ? 0.002 : 0 })),
    );
    expect(steady.annualized).toBeCloseTo(1.002 ** 183 - 1);
    // mean 0.000997, sd ≈ 0.001 (n-1): t ≈ 0.997 × √365 ≈ 19
    expect(steady.tStat).toBeGreaterThan(18);
    expect(steady.maxDrawdown).toBe(0);
  });

  it('selects a half-open window of days', () => {
    const returns = [1, 2, 3].map((n) => ({ day: n * D, r: 0 }));
    expect(between(returns, 2 * D, 3 * D).map((r) => r.day)).toEqual([2 * D]);
  });

  it('summarises trades by side and exit', () => {
    const base = {
      productId: 'BTC-USD',
      entryTime: 0,
      exitTime: 1,
      entryPrice: 1,
      exitPrice: 1,
      size: 1,
      grossPnl: 0,
      fees: 1,
      funding: 0.5,
      reason: '',
    } as const;
    const trades: ClosedTrade[] = [
      { ...base, direction: 'LONG', netPnl: 10, returnOnEquity: 0.01, exitReason: 'target' },
      { ...base, direction: 'SHORT', netPnl: -5, returnOnEquity: -0.005, exitReason: 'stop' },
      { ...base, direction: 'SHORT', netPnl: -1, returnOnEquity: -0.001, exitReason: 'stop' },
    ];
    const stats = tradeStats(trades);
    expect(stats.count).toBe(3);
    expect(stats.winRate).toBeCloseTo(1 / 3);
    expect(stats.averageWin).toBeCloseTo(0.01);
    expect(stats.averageLoss).toBeCloseTo(-0.003);
    expect(stats.expectancy).toBeCloseTo(0.004 / 3);
    expect(stats.long).toEqual({ count: 1, netPnl: 10 });
    expect(stats.short).toEqual({ count: 2, netPnl: -6 });
    expect(stats.fees).toBe(3);
    expect(stats.funding).toBe(1.5);
    expect(stats.exits).toEqual({ target: 1, stop: 2 });
  });
});
