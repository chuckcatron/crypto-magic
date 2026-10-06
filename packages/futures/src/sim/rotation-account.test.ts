import { describe, expect, it } from 'vitest';
import { T0 } from '../testing/bars';
import { DAY, type Bar } from '../types';
import { RotationAccount, type RotationAccountState } from './rotation-account';

const COSTS = { fillBps: 8, fundingBpsPerHour: 0.15 };
/** Daily growth rates: A strongest, G weakest. */
const RATES: Record<string, number> = {
  A: 0.03,
  B: 0.02,
  C: 0.01,
  D: 0,
  E: -0.01,
  F: -0.02,
  G: -0.03,
};

/** Flat-wicked daily bar: opens at the previous close. */
function dayBar(t: number, o: number, c: number, h = Math.max(o, c), l = Math.min(o, c)): Bar {
  return { t, o, h, l, c, v: 1 };
}

/** Every coin's bar for each day from `from` (inclusive) for `days` days, growing at its rate. */
function history(from: number, days: number): Map<number, Map<string, Bar>> {
  const out = new Map<number, Map<string, Bar>>();
  for (let n = 0; n < days; n++) {
    const day = from + n * DAY;
    const today = new Map<string, Bar>();
    for (const [coin, rate] of Object.entries(RATES)) {
      const open = 100 * (1 + rate) ** n;
      today.set(coin, dayBar(day, open, open * (1 + rate)));
    }
    out.set(day, today);
  }
  return out;
}

function feed(account: RotationAccount, days: Map<number, Map<string, Bar>>, until?: number): void {
  for (const [day, bars] of days) {
    if (until !== undefined && day > until) break;
    account.onDay(day, bars);
  }
}

describe('RotationAccount', () => {
  // T0 is a Monday. Thirty days of history end on the Sunday before it.
  const start = T0 - 30 * DAY;

  it('ranks by 21-day return and holds the top and bottom thirds', () => {
    const account = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(account, history(start, 30));
    const plan = account.lastPlan!;
    expect(plan.ranking.map((r) => r.productId)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    // N = 7, so ⌊7/3⌋ = 2 a side.
    expect(plan.longs).toEqual(['A', 'B']);
    expect(plan.shorts).toEqual(['F', 'G']);
  });

  it('needs a close on each of the previous 22 days, and at least 6 coins', () => {
    const days = history(start, 30);
    // G misses one day inside the lookback, so only 6 coins are eligible: 2 a side.
    days.get(T0 - 10 * DAY)!.delete('G');
    const account = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(account, days);
    expect(account.lastPlan!.ranking.map((r) => r.productId)).not.toContain('G');
    expect(account.lastPlan!.shorts).toEqual(['E', 'F']);

    days.get(T0 - 10 * DAY)!.delete('F');
    const thin = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(thin, days);
    expect(thin.lastPlan!.longs).toEqual([]);
  });

  it('fills Monday at the open with equal notional, paying fees and a day of funding', () => {
    const days = history(start, 31);
    const account = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(account, days);
    expect(account.positions.map((p) => [p.productId, p.direction])).toEqual([
      ['A', 'LONG'],
      ['B', 'LONG'],
      ['F', 'SHORT'],
      ['G', 'SHORT'],
    ]);
    const monday = days.get(T0)!;
    for (const p of account.positions) {
      expect(p.size * monday.get(p.productId)!.o).toBeCloseTo(2500);
    }
    const fees = 4 * 2500 * 0.0008;
    const funding = 4 * 2500 * ((0.15 * 24) / 10_000);
    const moves = ['A', 'B', 'F', 'G'].reduce((sum, coin) => {
      const bar = monday.get(coin)!;
      const side = RATES[coin]! > 0 ? 1 : -1;
      return sum + side * (2500 / bar.o) * (bar.c - bar.o);
    }, 0);
    expect(account.daily.at(-1)!.equity).toBeCloseTo(10_000 - fees - funding + moves, 6);
  });

  it('reports the last close each holding is marked at', () => {
    const days = history(start, 31);
    const account = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(account, days);
    const monday = days.get(T0)!;
    for (const p of account.positions)
      expect(account.priceOf(p.productId)).toBe(monday.get(p.productId)!.c);
    expect(account.priceOf('NOT-A-COIN')).toBeUndefined();
  });

  it('resizes a position that stays in its leg, paying only on the change', () => {
    const days = history(start, 38);
    const account = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(account, days, T0 + 6 * DAY);
    const before = new Map(account.positions.map((p) => [p.productId, p.size]));
    feed(account, new Map([[T0 + 7 * DAY, days.get(T0 + 7 * DAY)!]]));
    expect(account.trades).toHaveLength(0);
    for (const p of account.positions) {
      expect(p.size).not.toBe(before.get(p.productId));
    }
  });

  it('stops a position out 20% against its fill and keeps it out until the next rebalance', () => {
    const days = history(start, 33);
    const tuesday = T0 + DAY;
    const a = days.get(tuesday)!.get('A')!;
    const fill = days.get(T0)!.get('A')!.o;
    days.get(tuesday)!.set('A', dayBar(tuesday, a.o, a.c, a.h, fill * 0.75));
    const account = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(account, days);

    const trade = account.trades[0]!;
    expect(trade.productId).toBe('A');
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitPrice).toBeCloseTo(fill * 0.8);
    expect(account.positions.map((p) => p.productId)).not.toContain('A');
  });

  it('closes everything at the last close when the window ends', () => {
    const account = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(account, history(start, 33));
    account.finish();
    expect(account.positions).toHaveLength(0);
    expect(account.trades.every((t) => t.exitReason === 'end')).toBe(true);
    expect(account.daily.at(-1)!.equity).toBeCloseTo(account.equity);
  });

  it('resumes from saved state exactly as if it had never stopped', () => {
    const days = history(start, 45);
    const straight = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(straight, days);

    const first = new RotationAccount({ costs: COSTS, initialEquity: 10_000, tradeFrom: T0 });
    feed(first, days, T0 + 3 * DAY);
    const state = JSON.parse(JSON.stringify(first.toState())) as RotationAccountState;
    const resumed = new RotationAccount(
      { costs: COSTS, initialEquity: 10_000, tradeFrom: T0 },
      state,
    );
    for (const [day, bars] of days) if (day > T0 + 3 * DAY) resumed.onDay(day, bars);

    expect(resumed.equity).toBeCloseTo(straight.equity, 9);
    expect(resumed.daily).toEqual(straight.daily);
    expect([...first.trades, ...resumed.trades]).toEqual(straight.trades);
  });

  it('with entries refused, a rebalance only closes and shrinks', () => {
    const days = history(start, 31);
    const account = new RotationAccount({
      costs: COSTS,
      initialEquity: 10_000,
      tradeFrom: T0,
      entriesAllowed: () => false,
    });
    feed(account, days);
    expect(account.positions).toHaveLength(0);
  });
});
