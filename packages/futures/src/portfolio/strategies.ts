import { DAY } from '../types';
import type { PortfolioContext, PortfolioDecision, PortfolioStrategy } from './engine';
import type { DailyMarket } from './market';

/**
 * EXPERIMENT-009's six rules and three benchmarks, exactly as pre-registered
 * in docs/EXPERIMENT-009-any-crypto.md. Long only, daily closes.
 */

const MOMENTUM_DAYS = 28;

const isSunday = (day: number) => new Date(day * 1000).getUTCDay() === 0;

/** Coins ranked strongest first by 28-day return; coins without one are left out. Ties by symbol. */
function byMomentum(market: DailyMarket, day: number, symbols: readonly string[]): string[] {
  return symbols
    .map((symbol) => ({ symbol, ret: market.returnOver(symbol, day, MOMENTUM_DAYS) }))
    .filter((r): r is { symbol: string; ret: number } => r.ret !== undefined)
    .sort((a, b) => b.ret - a.ret || compare(a.symbol, b.symbol))
    .map((r) => r.symbol);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const SELL_EVERYTHING: PortfolioDecision = { kind: 'target', weights: new Map() };
const HOLD: PortfolioDecision = { kind: 'hold' };

function rotation(context: PortfolioContext, top: number): PortfolioDecision {
  const picks = byMomentum(context.market, context.day, context.universe).slice(0, top);
  return { kind: 'target', weights: new Map(picks.map((s) => [s, 1 / top])) };
}

/** S1 — every Sunday close, hold the top 5 of the universe by 28-day return, 20% each. */
export const momentumRotation: PortfolioStrategy = {
  id: 'S1',
  name: 'momentum rotation, top 5 by 28-day return, weekly',
  slots: 5,
  decide(context) {
    return isSunday(context.day) ? rotation(context, 5) : HOLD;
  },
};

/** S1R — S1, out of everything whenever BTC closes below its 200-day SMA. */
export const gatedMomentumRotation: PortfolioStrategy = {
  id: 'S1R',
  name: 'S1 behind the BTC 200-day gate',
  slots: 5,
  decide(context) {
    if (context.btcRiskOn !== true) return context.holdings.size > 0 ? SELL_EVERYTHING : HOLD;
    return isSunday(context.day) ? rotation(context, 5) : HOLD;
  },
};

/** Coins in the universe, not held, whose close is above their prior 20-day high. */
function breakouts(context: PortfolioContext, needVolumeSurge: boolean): string[] {
  const { market, day } = context;
  const found = context.universe.filter((symbol) => {
    if (context.holdings.has(symbol)) return false;
    const bar = market.bar(symbol, day);
    const high = market.highestClose(symbol, day, 20);
    if (!bar || high === undefined || !(bar.c > high)) return false;
    if (!needVolumeSurge) return true;
    const today = market.dollarVolumeOn(symbol, day);
    const usual = market.meanDollarVolume(symbol, day - 30 * DAY, day - DAY);
    return today !== undefined && usual !== undefined && usual > 0 && today >= 3 * usual;
  });
  return byMomentum(market, day, found);
}

/** Held coins whose close is below their prior 10-day low. */
function breakdowns(context: PortfolioContext): string[] {
  const { market, day } = context;
  return [...context.holdings.keys()].filter((symbol) => {
    const bar = market.bar(symbol, day);
    const low = market.lowestClose(symbol, day, 10);
    return bar !== undefined && low !== undefined && bar.c < low;
  });
}

/** S2 — buy a close above the 20-day high, sell a close below the 10-day low. 10 slots. */
export const breakout: PortfolioStrategy = {
  id: 'S2',
  name: 'breakout, 20-day high in, 10-day low out',
  slots: 10,
  decide(context) {
    return { kind: 'slots', exits: breakdowns(context), entries: breakouts(context, false) };
  },
};

/** S2R — S2, with no entries and everything sold whenever BTC is below its 200-day SMA. */
export const gatedBreakout: PortfolioStrategy = {
  id: 'S2R',
  name: 'S2 behind the BTC 200-day gate',
  slots: 10,
  decide(context) {
    if (context.btcRiskOn !== true) {
      return { kind: 'slots', exits: [...context.holdings.keys()], entries: [] };
    }
    return { kind: 'slots', exits: breakdowns(context), entries: breakouts(context, false) };
  },
};

/** S3 — S2's breakout, only on a day of at least 3× the prior 30 days' average dollar volume. */
export const volumeSurge: PortfolioStrategy = {
  id: 'S3',
  name: 'volume-surge breakout',
  slots: 10,
  decide(context) {
    return { kind: 'slots', exits: breakdowns(context), entries: breakouts(context, true) };
  },
};

/** S4 — Connors RSI(2): buy RSI(2) < 10 above the coin's 200-day SMA, sell a close above the 5-day SMA. */
export const dipBuying: PortfolioStrategy = {
  id: 'S4',
  name: 'dip buying, Connors RSI(2)',
  slots: 10,
  decide(context) {
    const { market, day } = context;
    const exits = [...context.holdings.keys()].filter((symbol) => {
      const bar = market.bar(symbol, day);
      const sma5 = market.sma(symbol, day, 5);
      return bar !== undefined && sma5 !== undefined && bar.c > sma5;
    });
    const entries = context.universe
      .filter((symbol) => !context.holdings.has(symbol))
      .map((symbol) => {
        const bar = market.bar(symbol, day);
        const sma200 = market.sma(symbol, day, 200);
        const rsi2 = market.rsi(symbol, day, 2, 100);
        if (bar === undefined || sma200 === undefined || rsi2 === undefined) return null;
        return rsi2 < 10 && bar.c > sma200 ? { symbol, rsi2 } : null;
      })
      .filter((e): e is { symbol: string; rsi2: number } => e !== null)
      .sort((a, b) => a.rsi2 - b.rsi2 || compare(a.symbol, b.symbol))
      .map((e) => e.symbol);
    return { kind: 'slots', exits, entries };
  },
};

export const CANDIDATES: readonly PortfolioStrategy[] = [
  momentumRotation,
  gatedMomentumRotation,
  breakout,
  gatedBreakout,
  volumeSurge,
  dipBuying,
];

/** Benchmark: hold the venue's BTC. */
export function holdBtc(btcSymbol: string): PortfolioStrategy {
  let bought = false;
  return {
    id: 'BTC',
    name: 'hold BTC',
    slots: 1,
    decide() {
      if (bought) return HOLD;
      bought = true;
      return { kind: 'target', weights: new Map([[btcSymbol, 1]]) };
    },
  };
}

/** Benchmark: the point-in-time top 50, equal weight, rebalanced at each month's first open. */
export const equalWeightUniverse: PortfolioStrategy = {
  id: 'EW50',
  name: 'top 50 equal weight, monthly',
  slots: 50,
  decide(context) {
    const tomorrow = new Date((context.day + DAY) * 1000);
    const first = context.holdings.size === 0 || tomorrow.getUTCDate() === 1;
    if (!first) return HOLD;
    const n = context.universe.length;
    return {
      kind: 'target',
      weights: new Map(context.universe.map((s) => [s, 1 / Math.max(n, 1)])),
    };
  },
};

/** Benchmark: EXPERIMENT-001's regime filter, BTC above its 200-day SMA, else cash (no stop). */
export function btcRegime(btcSymbol: string): PortfolioStrategy {
  return {
    id: 'BTC200',
    name: 'BTC above its 200-day SMA, else cash',
    slots: 1,
    decide(context) {
      const holding = context.holdings.size > 0;
      if (context.btcRiskOn === true && !holding) {
        return { kind: 'target', weights: new Map([[btcSymbol, 1]]) };
      }
      if (context.btcRiskOn !== true && holding) return SELL_EVERYTHING;
      return HOLD;
    },
  };
}
