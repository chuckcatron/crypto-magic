import { DAY, type DailyMark } from '../types';
import type { DailyMarket } from './market';

/** What a long-only portfolio rule can see at a daily close. */
export interface PortfolioContext {
  /** The decision day: the UTC midnight its bar opened. The decision is at its close. */
  readonly day: number;
  readonly market: DailyMarket;
  /** EXPERIMENT-009's point-in-time universe at this close. */
  readonly universe: readonly string[];
  readonly holdings: ReadonlyMap<string, Readonly<PortfolioHolding>>;
  /** Cash plus holdings marked at this close. */
  readonly equity: number;
  /** The venue's BTC closed above its 200-day SMA; undefined without enough history. */
  readonly btcRiskOn: boolean | undefined;
}

/**
 * A decision, filled at the next day's open.
 *  - target: rebalance to these weights of equity (missing = sell).
 *  - slots: sell `exits`, then fill free slots from `entries`, best first.
 *  - hold: do nothing.
 */
export type PortfolioDecision =
  | { readonly kind: 'target'; readonly weights: ReadonlyMap<string, number> }
  | {
      readonly kind: 'slots';
      readonly exits: readonly string[];
      readonly entries: readonly string[];
    }
  | { readonly kind: 'hold' };

export interface PortfolioStrategy {
  readonly id: string;
  readonly name: string;
  /** Number of equal slots for 'slots' decisions. */
  readonly slots: number;
  decide(context: PortfolioContext): PortfolioDecision;
}

export interface PortfolioHolding {
  readonly symbol: string;
  units: number;
  /** Everything spent on what is still held, fees included. */
  costBasis: number;
  readonly openedAt: number;
}

export interface PortfolioTrade {
  readonly symbol: string;
  readonly openedAt: number;
  readonly closedAt: number;
  /** Net of fees on both sides. */
  readonly returnPct: number;
  readonly reason: 'sell' | 'delisted' | 'end';
}

export interface PortfolioRun {
  readonly strategy: string;
  readonly initialEquity: number;
  readonly daily: DailyMark[];
  readonly trades: PortfolioTrade[];
  /** Mean share of equity held in coins at each close. */
  readonly averageInvested: number;
}

/**
 * EXPERIMENT-009's long-only, spot, no-leverage portfolio over daily bars.
 *
 * Per day in [from, to):
 *   1. a held coin with no bar today is closed at its last close (delisting);
 *   2. yesterday's decision fills at today's open, sells before buys, each
 *      paying the fill cost; a buy is cut to the cash available;
 *   3. equity is marked at the close;
 *   4. the strategy decides at the close.
 * The first decision is made at the close of the day before `from`, so every
 * strategy can be invested from the first day. At the end, everything is sold
 * at the last close.
 */
export function runPortfolio(args: {
  readonly market: DailyMarket;
  readonly strategy: PortfolioStrategy;
  readonly fillBps: number;
  readonly btcSymbol: string;
  readonly from: number;
  readonly to: number;
  readonly initialEquity?: number;
}): PortfolioRun {
  const { market, strategy } = args;
  const cost = args.fillBps / 10_000;
  const initialEquity = args.initialEquity ?? 10_000;
  let cash = initialEquity;
  const holdings = new Map<string, PortfolioHolding>();
  const trades: PortfolioTrade[] = [];
  const daily: DailyMark[] = [];
  let invested = 0;
  let pending: { decision: PortfolioDecision; equity: number } | null = null;

  const markAt = (day: number, price: 'o' | 'c'): number => {
    let total = cash;
    for (const h of holdings.values()) {
      const bar = market.bar(h.symbol, day) ?? market.lastBarBefore(h.symbol, day);
      total += h.units * (bar ? bar[price] : 0);
    }
    return total;
  };

  const sell = (
    h: PortfolioHolding,
    units: number,
    price: number,
    day: number,
    reason: PortfolioTrade['reason'],
  ) => {
    const proceeds = units * price * (1 - cost);
    cash += proceeds;
    const share = units / h.units;
    const basis = h.costBasis * share;
    h.costBasis -= basis;
    h.units -= units;
    if (share >= 1 - 1e-12) {
      holdings.delete(h.symbol);
      trades.push({
        symbol: h.symbol,
        openedAt: h.openedAt,
        closedAt: day,
        returnPct: basis > 0 ? proceeds / basis - 1 : 0,
        reason,
      });
    }
  };

  const buy = (symbol: string, notional: number, price: number, day: number) => {
    const affordable = Math.min(notional, cash / (1 + cost));
    if (!(affordable > 0)) return;
    const spent = affordable * (1 + cost);
    cash -= spent;
    const held = holdings.get(symbol);
    if (held) {
      held.units += affordable / price;
      held.costBasis += spent;
    } else {
      holdings.set(symbol, { symbol, units: affordable / price, costBasis: spent, openedAt: day });
    }
  };

  const decideAt = (day: number) => {
    const equity = markAt(day, 'c');
    const btcClose = market.bar(args.btcSymbol, day)?.c;
    const btcSma = market.sma(args.btcSymbol, day, 200);
    const context: PortfolioContext = {
      day,
      market,
      universe: market.universe(day),
      holdings,
      equity,
      btcRiskOn: btcClose !== undefined && btcSma !== undefined ? btcClose > btcSma : undefined,
    };
    pending = { decision: strategy.decide(context), equity };
  };

  decideAt(args.from - DAY);

  for (let day = args.from; day < args.to; day += DAY) {
    // 1. Delistings: no bar today means sold at the last close.
    for (const h of [...holdings.values()]) {
      if (!market.bar(h.symbol, day)) {
        const last = market.lastBarBefore(h.symbol, day);
        sell(h, h.units, last ? last.c : 0, day, 'delisted');
      }
    }

    // 2. Fill yesterday's decision at today's open.
    const order = pending as { decision: PortfolioDecision; equity: number } | null;
    pending = null;
    if (order) fill(order.decision, order.equity, day);

    // 3. Mark at the close.
    const equity = markAt(day, 'c');
    daily.push({ day, equity });
    invested += equity > 0 ? (equity - cash) / equity : 0;

    // 4. Decide at the close, unless the window ends with this day.
    if (day + DAY < args.to) decideAt(day);
  }

  // Sell everything at the last close.
  const lastDay = args.to - DAY;
  for (const h of [...holdings.values()]) {
    const bar = market.bar(h.symbol, lastDay) ?? market.lastBarBefore(h.symbol, lastDay);
    sell(h, h.units, bar ? bar.c : 0, lastDay, 'end');
  }
  if (daily.length > 0) daily[daily.length - 1] = { day: daily.at(-1)!.day, equity: cash };

  return {
    strategy: strategy.id,
    initialEquity,
    daily,
    trades,
    averageInvested: daily.length > 0 ? invested / daily.length : 0,
  };

  function fill(decision: PortfolioDecision, decisionEquity: number, day: number): void {
    if (decision.kind === 'hold') return;
    const open = (symbol: string) => market.bar(symbol, day)?.o;

    if (decision.kind === 'target') {
      const equityAtOpen = markAt(day, 'o');
      // Sells and reductions first.
      for (const h of [...holdings.values()]) {
        const price = open(h.symbol);
        if (price === undefined) continue;
        const target = (decision.weights.get(h.symbol) ?? 0) * equityAtOpen;
        const value = h.units * price;
        if (target < value)
          sell(h, target <= 0 ? h.units : (value - target) / price, price, day, 'sell');
      }
      // Then additions, cut to the cash left.
      for (const [symbol, weight] of decision.weights) {
        const price = open(symbol);
        if (price === undefined || weight <= 0) continue;
        const value = (holdings.get(symbol)?.units ?? 0) * price;
        const target = weight * equityAtOpen;
        if (target > value) buy(symbol, target - value, price, day);
      }
      return;
    }

    for (const symbol of decision.exits) {
      const h = holdings.get(symbol);
      const price = open(symbol);
      if (h && price !== undefined) sell(h, h.units, price, day, 'sell');
    }
    let free = strategy.slots - holdings.size;
    for (const symbol of decision.entries) {
      if (free <= 0) break;
      if (holdings.has(symbol)) continue;
      const price = open(symbol);
      if (price === undefined) continue;
      buy(symbol, decisionEquity / strategy.slots, price, day);
      if (holdings.has(symbol)) free--;
    }
  }
}
