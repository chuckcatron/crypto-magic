import { describe, expect, it, vi } from 'vitest';
import { MarketSeries } from '../series';
import { bar, barsFromCloses, scripted, signal, T0 } from '../testing/bars';
import { DAY, FIVE_MINUTES, type Bar, type CostModel, type EntrySignal } from '../types';
import {
  IntradayAccount,
  type IntradayAccountOptions,
  type IntradayAccountState,
} from './intraday-account';

const NO_COSTS: CostModel = { fillBps: 0, fundingBpsPerHour: 0 };
const at = (n: number) => T0 + n * FIVE_MINUTES;

function setup(
  signals: Map<number, EntrySignal>,
  overrides: Partial<IntradayAccountOptions> = {},
): { account: IntradayAccount; feed: (bars: Bar[]) => void } {
  const series = new MarketSeries();
  const account = new IntradayAccount({
    productId: 'BTC-USD',
    strategy: scripted(signals),
    costs: NO_COSTS,
    initialEquity: 10_000,
    tradeFrom: T0,
    ...overrides,
  });
  return {
    account,
    feed(bars) {
      for (const b of bars) {
        series.append(b);
        account.onBar(b, series);
      }
    },
  };
}

describe('IntradayAccount', () => {
  it('fills at the next open, sized so the stop loses 0.5% of equity', () => {
    const { account, feed } = setup(
      new Map([[at(0), signal({ stopDistance: 2, targetDistance: 4 })]]),
    );
    feed([bar(at(0), 100, 100), bar(at(1), 101, 101)]);

    const position = account.openPosition!;
    expect(position.entryPrice).toBe(101);
    expect(position.entryTime).toBe(at(1));
    expect(position.stop).toBe(99);
    expect(position.target).toBe(105);
    // 0.5% of 10,000 = 50 at risk over a 2-point stop.
    expect(position.size).toBe(25);
  });

  it('caps the position at 1× equity when the stop is tight', () => {
    const { account, feed } = setup(new Map([[at(0), signal({ stopDistance: 0.1 })]]));
    feed([bar(at(0), 100, 100), bar(at(1), 100, 100)]);
    // Risk sizing would buy 500; 1× of 10,000 at 100 is 100.
    expect(account.openPosition!.size).toBe(100);
  });

  it('exits at the target and books fees and funding', () => {
    const costs = { fillBps: 8, fundingBpsPerHour: 0.15 };
    const { account, feed } = setup(
      new Map([[at(0), signal({ stopDistance: 2, targetDistance: 4 })]]),
      {
        costs,
      },
    );
    feed([bar(at(0), 100, 100), bar(at(1), 100, 101), bar(at(2), 101, 103.5, 10, 0)]);
    expect(account.openPosition).not.toBeNull();
    feed([{ t: at(3), o: 104, h: 105, l: 103.9, c: 104.9, v: 10 }]);

    const trade = account.trades[0]!;
    expect(trade.exitReason).toBe('target');
    expect(trade.exitPrice).toBe(104);
    const size = 25;
    const entryFee = (size * 100 * 8) / 10_000;
    const exitFee = (size * 104 * 8) / 10_000;
    // Held from the entry bar's open to the exit bar's close: 15 minutes.
    const funding = (size * 100 * 0.15 * 0.25) / 10_000;
    expect(trade.grossPnl).toBeCloseTo(size * 4);
    expect(trade.fees).toBeCloseTo(entryFee + exitFee);
    expect(trade.funding).toBeCloseTo(funding);
    expect(trade.netPnl).toBeCloseTo(100 - entryFee - exitFee - funding);
    expect(account.equity).toBeCloseTo(10_000 + trade.netPnl);
  });

  it('takes the stop when one bar touches both the stop and the target', () => {
    const { account, feed } = setup(
      new Map([[at(0), signal({ stopDistance: 1, targetDistance: 1 })]]),
    );
    feed([bar(at(0), 100, 100), bar(at(1), 100, 100, 10, 0)]);
    feed([{ t: at(2), o: 100, h: 102, l: 98, c: 100, v: 1 }]);
    expect(account.trades[0]!.exitReason).toBe('stop');
    expect(account.trades[0]!.exitPrice).toBe(99);
  });

  it('fills a stop at the open when the bar opens through it', () => {
    const { account, feed } = setup(new Map([[at(0), signal({ stopDistance: 1 })]]));
    feed([bar(at(0), 100, 100), bar(at(1), 100, 100, 10, 0)]);
    feed([{ t: at(2), o: 95, h: 96, l: 94, c: 95, v: 1 }]);
    expect(account.trades[0]!.exitPrice).toBe(95);
    expect(account.trades[0]!.exitTime).toBe(at(2));
  });

  it('mirrors everything for a short', () => {
    const { account, feed } = setup(
      new Map([[at(0), signal({ direction: 'SHORT', stopDistance: 2, targetDistance: 3 })]]),
    );
    feed([bar(at(0), 100, 100), bar(at(1), 100, 100, 10, 0)]);
    expect(account.openPosition!.stop).toBe(102);
    expect(account.openPosition!.target).toBe(97);
    feed([{ t: at(2), o: 99, h: 99.5, l: 96.5, c: 97, v: 1 }]);
    const trade = account.trades[0]!;
    expect(trade.exitReason).toBe('target');
    expect(trade.grossPnl).toBeCloseTo(25 * 3);
  });

  it('time-stops at the open of the first bar at or after the deadline, before stop and target', () => {
    const { account, feed } = setup(
      new Map([
        [at(0), signal({ stopDistance: 5, targetDistance: 5, maxHoldSeconds: 2 * FIVE_MINUTES })],
      ]),
    );
    feed([bar(at(0), 100, 100), bar(at(1), 100, 100, 10, 0), bar(at(2), 100, 100, 10, 0)]);
    // This bar would hit the target, but the hold has run out at its open.
    feed([{ t: at(3), o: 101, h: 110, l: 100, c: 104, v: 1 }]);
    const trade = account.trades[0]!;
    expect(trade.exitReason).toBe('time');
    expect(trade.exitPrice).toBe(101);
  });

  it('halts new entries for the rest of the UTC day after a 2% realized loss', () => {
    const losing = signal({ stopDistance: 1, targetDistance: 10 });
    const signals = new Map<number, EntrySignal>();
    // Six chances to lose 0.5% of a shrinking equity. Four such losses come to
    // 1.985%; the fifth crosses 2% and the sixth signal is ignored.
    for (let n = 0; n < 6; n++) signals.set(at(n * 2), losing);
    const halted = vi.fn();
    const { account, feed } = setup(signals);
    account.listener = { halted };

    const bars: Bar[] = [];
    for (let n = 0; n < 6; n++) {
      bars.push(bar(at(n * 2), 100, 100, 10, 0));
      // Opens at 100 (the entry), then trades down through the 99 stop.
      bars.push({ t: at(n * 2 + 1), o: 100, h: 100, l: 98.5, c: 100, v: 1 });
    }
    feed(bars);
    expect(account.trades).toHaveLength(5);
    expect(account.halted).toBe(true);
    expect(halted).toHaveBeenCalledOnce();

    // Next UTC day: entries allowed again.
    const tomorrow = T0 + DAY;
    signals.set(tomorrow, losing);
    feed([bar(tomorrow, 100, 100, 10, 0), bar(tomorrow + FIVE_MINUTES, 100, 100, 10, 0)]);
    expect(account.halted).toBe(false);
    expect(account.openPosition).not.toBeNull();
  });

  it('makes no decision before tradeFrom, and marks every day after it', () => {
    const signals = new Map([[at(0), signal()]]);
    const { account, feed } = setup(signals, { tradeFrom: T0 + DAY });
    feed([bar(at(0), 100, 100), bar(at(1), 100, 100)]);
    expect(account.openPosition).toBeNull();

    const day1 = T0 + DAY;
    // Day 2 has no bars at all.
    const day3 = T0 + 3 * DAY;
    feed([bar(day1, 100, 100), bar(day3, 100, 100)]);
    account.finish();
    expect(account.daily.map((d) => d.day)).toEqual([day1, day1 + DAY, day3]);
  });

  it('closes what is open at the last close when the window ends', () => {
    const { account, feed } = setup(
      new Map([[at(0), signal({ stopDistance: 5, targetDistance: 5 })]]),
    );
    feed([bar(at(0), 100, 100), bar(at(1), 100, 102, 10, 0)]);
    account.finish();
    expect(account.trades[0]!.exitReason).toBe('end');
    expect(account.trades[0]!.exitPrice).toBe(102);
    expect(account.daily.at(-1)!.equity).toBeCloseTo(10_000 + account.trades[0]!.netPnl);
  });

  it('resumes from saved state exactly as if it had never stopped', () => {
    const signals = new Map([
      [at(1), signal({ stopDistance: 2, targetDistance: 3 })],
      [at(6), signal({ direction: 'SHORT', stopDistance: 2, targetDistance: 3 })],
    ]);
    const costs = { fillBps: 8, fundingBpsPerHour: 0.15 };
    const bars = barsFromCloses([100, 101, 102, 104, 103, 101, 100, 99, 97, 96, 98]);

    const straight = setup(signals, { costs });
    straight.feed(bars);

    const first = setup(signals, { costs });
    first.feed(bars.slice(0, 5));
    const state = JSON.parse(JSON.stringify(first.account.toState())) as IntradayAccountState;
    const series = new MarketSeries();
    for (const b of bars.slice(0, 5)) series.append(b);
    const resumed = new IntradayAccount(
      {
        productId: 'BTC-USD',
        strategy: scripted(signals),
        costs,
        initialEquity: 10_000,
        tradeFrom: T0,
      },
      state,
    );
    for (const b of bars.slice(5)) {
      series.append(b);
      resumed.onBar(b, series);
    }

    expect(resumed.equity).toBeCloseTo(straight.account.equity, 9);
    expect(resumed.toState().position).toEqual(straight.account.toState().position);
    expect([...first.account.trades, ...resumed.trades]).toEqual(straight.account.trades);
  });
});
