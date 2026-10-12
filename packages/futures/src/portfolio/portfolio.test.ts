import { describe, expect, it } from 'vitest';
import { DAY, type Bar } from '../types';
import {
  runPortfolio,
  type PortfolioContext,
  type PortfolioDecision,
  type PortfolioStrategy,
} from './engine';
import { DailyMarket } from './market';
import {
  breakout,
  btcRegime,
  dipBuying,
  equalWeightUniverse,
  gatedMomentumRotation,
  holdBtc,
  momentumRotation,
  volumeSurge,
} from './strategies';
import { fixedBtcAllocation, matchedBtcAllocation } from './yardstick';

/** 2026-01-04, a Sunday. */
const SUNDAY = Date.UTC(2026, 0, 4) / 1000;
const D0 = SUNDAY - 300 * DAY;

function series(
  closes: readonly number[],
  options: { start?: number; volume?: number | ((i: number) => number) } = {},
): Bar[] {
  const start = options.start ?? D0;
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1]!;
    const v = typeof options.volume === 'function' ? options.volume(i) : (options.volume ?? 1000);
    return { t: start + i * DAY, o, h: Math.max(o, c), l: Math.min(o, c), c, v };
  });
}

const flat = (n: number, price = 100) => new Array<number>(n).fill(price);
const ramp = (n: number, from: number, step: number) =>
  Array.from({ length: n }, (_, i) => from * (1 + step) ** i);

function market(coins: Record<string, Bar[]>, size = 50): DailyMarket {
  return new DailyMarket(new Map(Object.entries(coins)), {
    universeSize: size,
    minHistory: 60,
    volumeDays: 30,
  });
}

/** A strategy that returns the given decisions on the given days, and holds otherwise. */
function scripted(decisions: Map<number, PortfolioDecision>, slots = 10): PortfolioStrategy {
  return {
    id: 'T',
    name: 'scripted',
    slots,
    decide: (context: PortfolioContext) => decisions.get(context.day) ?? { kind: 'hold' },
  };
}

describe('DailyMarket', () => {
  const m = market({ A: series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) });
  const day = (i: number) => D0 + i * DAY;

  it('reads highs and lows from the days before, never today', () => {
    expect(m.highestClose('A', day(11), 3)).toBe(11);
    expect(m.lowestClose('A', day(11), 3)).toBe(9);
    expect(m.highestClose('A', day(0), 3)).toBeUndefined();
  });

  it('needs the exact bar for a return over n days', () => {
    expect(m.returnOver('A', day(10), 5)).toBeCloseTo(11 / 6 - 1);
    expect(m.returnOver('A', day(3), 5)).toBeUndefined();
  });

  it('takes an SMA over the last n bars, today included', () => {
    expect(m.sma('A', day(11), 4)).toBe((9 + 10 + 11 + 12) / 4);
    expect(m.sma('A', day(2), 4)).toBeUndefined();
  });

  it('ranks the universe by 30-day dollar volume, needing 60 bars and a bar that day', () => {
    const big = series(flat(100), { volume: 10_000 });
    const small = series(flat(100), { volume: 10 });
    const young = series(flat(40), { start: D0 + 60 * DAY, volume: 1e9 });
    const gone = series(flat(80), { volume: 1e9 });
    const u = market({ BIG: big, SMALL: small, YOUNG: young, GONE: gone }, 1);
    expect(u.universe(D0 + 99 * DAY)).toEqual(['BIG']);
    expect(market({ BIG: big, SMALL: small }, 5).universe(D0 + 99 * DAY)).toEqual(['BIG', 'SMALL']);
  });
});

describe('runPortfolio', () => {
  const m = market({ A: series(ramp(400, 100, 0.001)), B: series(flat(400, 50)) });
  const from = D0 + 300 * DAY;
  const to = from + 10 * DAY;

  it('makes its first decision the evening before, so it can be invested from the first open', () => {
    const run = runPortfolio({
      market: m,
      strategy: scripted(new Map([[from - DAY, { kind: 'target', weights: new Map([['B', 1]]) }]])),
      fillBps: 100,
      btcSymbol: 'A',
      from,
      to,
    });
    // B is flat at 50: the only change is the 1% cost on the buy and on the final sale.
    expect(run.daily[0]!.equity).toBeCloseTo(10_000 / 1.01, 6);
    expect(run.daily.at(-1)!.equity).toBeCloseTo((10_000 / 1.01) * 0.99, 6);
    expect(run.trades).toHaveLength(1);
    expect(run.trades[0]!.reason).toBe('end');
  });

  it('sizes a slot from equity at the decision and never spends cash it does not have', () => {
    const run = runPortfolio({
      market: m,
      strategy: scripted(
        new Map([[from - DAY, { kind: 'slots', exits: [], entries: ['A', 'B'] }]]),
        2,
      ),
      fillBps: 0,
      btcSymbol: 'A',
      from,
      to,
    });
    expect(run.daily[0]!.equity).toBeGreaterThan(0);
    expect(run.averageInvested).toBeCloseTo(1, 6);
  });

  it('books a delisting at the last close', () => {
    const dying = series([...flat(305, 10), 5, 1]);
    const dm = market({ A: series(flat(400, 100)), D: dying });
    const run = runPortfolio({
      market: dm,
      strategy: scripted(new Map([[from - DAY, { kind: 'target', weights: new Map([['D', 1]]) }]])),
      fillBps: 0,
      btcSymbol: 'A',
      from,
      to,
    });
    const trade = run.trades[0]!;
    expect(trade.reason).toBe('delisted');
    // Bought at 10, last traded at 1.
    expect(trade.returnPct).toBeCloseTo(-0.9, 6);
  });
});

describe('the strategies', () => {
  it('S1 rotates into the strongest five on Sundays only', () => {
    const coins: Record<string, Bar[]> = {};
    for (let k = 0; k < 7; k++) coins[`C${k}`] = series(ramp(320, 100, 0.001 * (k + 1)));
    const m = market(coins);
    const monday = SUNDAY + DAY;
    const run = runPortfolio({
      market: m,
      strategy: momentumRotation,
      fillBps: 0,
      btcSymbol: 'C0',
      from: monday,
      to: monday + 3 * DAY,
    });
    // Decision the evening before Monday is Sunday's: invested from Monday's open.
    expect(run.daily[0]!.equity).not.toBe(10_000);
    const tuesday = runPortfolio({
      market: m,
      strategy: momentumRotation,
      fillBps: 0,
      btcSymbol: 'C0',
      from: monday + DAY,
      to: monday + 3 * DAY,
    });
    expect(tuesday.daily.every((d) => d.equity === 10_000)).toBe(true);
  });

  it('S1R sells everything when BTC closes below its 200-day SMA', () => {
    const btc = series([...ramp(280, 100, 0.002), ...ramp(40, 170, -0.02)]);
    const coins: Record<string, Bar[]> = { BTC: btc };
    for (let k = 0; k < 5; k++) coins[`C${k}`] = series(ramp(320, 100, 0.001 * (k + 1)));
    const m = market(coins);
    const from = SUNDAY - 34 * DAY;
    const run = runPortfolio({
      market: m,
      strategy: gatedMomentumRotation,
      fillBps: 0,
      btcSymbol: 'BTC',
      from,
      to: SUNDAY + 2 * DAY,
    });
    expect(run.trades.length).toBeGreaterThan(0);
    expect(run.daily.at(-2)!.equity).toBeCloseTo(run.daily.at(-1)!.equity, 6);
  });

  it('S2 buys a close above the 20-day high and sells one below the 10-day low', () => {
    const closes = [...flat(300, 100), 110, 111, 112, 90, 90, 90];
    const m = market({ X: series(closes), BTC: series(flat(306)) });
    const from = D0 + 299 * DAY;
    const run = runPortfolio({
      market: m,
      strategy: breakout,
      fillBps: 0,
      btcSymbol: 'BTC',
      from,
      to: D0 + 306 * DAY,
    });
    expect(run.trades[0]!.symbol).toBe('X');
    expect(run.trades[0]!.reason).toBe('sell');
    // In at day 301's open (110), out at day 304's open (90).
    expect(run.trades[0]!.returnPct).toBeCloseTo(90 / 110 - 1, 6);
  });

  it('S3 needs three times the usual dollar volume on the breakout day', () => {
    const closes = [...flat(300, 100), 110, 111, 112];
    const quiet = market({ X: series(closes), BTC: series(flat(303)) });
    const loud = market({
      X: series(closes, { volume: (i) => (i === 300 ? 5000 : 1000) }),
      BTC: series(flat(303)),
    });
    const args = { fillBps: 0, btcSymbol: 'BTC', from: D0 + 300 * DAY, to: D0 + 303 * DAY };
    expect(runPortfolio({ market: quiet, strategy: volumeSurge, ...args }).trades).toHaveLength(0);
    expect(runPortfolio({ market: loud, strategy: volumeSurge, ...args }).trades).toHaveLength(1);
  });

  it('S4 buys a sharp dip in an uptrend and sells the bounce above the 5-day SMA', () => {
    const closes = [...ramp(300, 100, 0.002), 170, 160, 150, 175, 180];
    const m = market({ X: series(closes), BTC: series(flat(305)) });
    const run = runPortfolio({
      market: m,
      strategy: dipBuying,
      fillBps: 0,
      btcSymbol: 'BTC',
      from: D0 + 301 * DAY,
      to: D0 + 305 * DAY,
    });
    expect(run.trades[0]!.symbol).toBe('X');
    expect(run.trades[0]!.returnPct).toBeGreaterThan(0);
  });

  it('the benchmarks: hold BTC, equal weight, and the regime filter', () => {
    const m = market({ BTC: series(ramp(400, 100, 0.001)), Y: series(flat(400, 10)) });
    const args = {
      market: m,
      fillBps: 0,
      btcSymbol: 'BTC',
      from: D0 + 300 * DAY,
      to: D0 + 330 * DAY,
    };
    const hold = runPortfolio({ ...args, strategy: holdBtc('BTC') });
    expect(hold.daily.at(-1)!.equity / 10_000).toBeCloseTo(1.001 ** 30, 2);
    const ew = runPortfolio({ ...args, strategy: equalWeightUniverse });
    expect(ew.averageInvested).toBeCloseTo(1, 6);
    const regime = runPortfolio({ ...args, strategy: btcRegime('BTC') });
    expect(regime.trades).toHaveLength(1);
  });
});

describe('the yardstick', () => {
  const m = market({ BTC: series([...ramp(150, 100, 0.01), ...ramp(150, 440, -0.01)]) });
  const args = { market: m, btcSymbol: 'BTC', fillBps: 65, from: D0, to: D0 + 300 * DAY };

  it('at 100% is holding BTC, and at 0% is cash', () => {
    const full = fixedBtcAllocation({ ...args, fraction: 1 });
    expect(full[100]!.equity).toBeGreaterThan(20_000);
    const none = fixedBtcAllocation({ ...args, fraction: 0 });
    expect(none.every((d) => d.equity === 10_000)).toBe(true);
  });

  it('finds the fraction whose drawdown matches the target', () => {
    const matched = matchedBtcAllocation({ ...args, targetDrawdown: 0.3 });
    expect(matched.fraction).toBeGreaterThan(0);
    expect(matched.fraction).toBeLessThan(1);
    expect(matched.performance.maxDrawdown).toBeCloseTo(0.3, 3);
    expect(matchedBtcAllocation({ ...args, targetDrawdown: 0.99 }).fraction).toBe(1);
  });
});
