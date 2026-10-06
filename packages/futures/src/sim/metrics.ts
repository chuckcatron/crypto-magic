import type { ClosedTrade, DailyMark, ExitReason } from '../types';

export interface DailyReturn {
  /** 00:00 UTC of the day, in UNIX seconds. */
  readonly day: number;
  readonly r: number;
}

/** Day-over-day returns from end-of-day equity; the first day is measured from the starting equity. */
export function returnsFromMarks(
  marks: readonly DailyMark[],
  initialEquity: number,
): DailyReturn[] {
  let previous = initialEquity;
  return marks.map((mark) => {
    const r = mark.equity / previous - 1;
    previous = mark.equity;
    return { day: mark.day, r };
  });
}

/**
 * EXPERIMENT-008's pooled daily return: for each day, the mean return of the
 * sub-accounts trading that day. Equivalent to splitting capital equally
 * across them and rebalancing daily.
 */
export function poolReturns(series: readonly (readonly DailyReturn[])[]): DailyReturn[] {
  const byDay = new Map<number, { sum: number; count: number }>();
  for (const returns of series) {
    for (const { day, r } of returns) {
      const entry = byDay.get(day) ?? { sum: 0, count: 0 };
      entry.sum += r;
      entry.count += 1;
      byDay.set(day, entry);
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, { sum, count }]) => ({ day, r: sum / count }));
}

/** Returns for days in [from, to). */
export function between(returns: readonly DailyReturn[], from: number, to: number): DailyReturn[] {
  return returns.filter((d) => d.day >= from && d.day < to);
}

export interface Performance {
  readonly days: number;
  readonly totalReturn: number;
  /** Compounded and scaled to 365 days (crypto trades every day). */
  readonly annualized: number;
  /** Mean daily return ÷ (sample standard deviation ÷ √days). */
  readonly tStat: number;
  /** Deepest fall from a peak of the compounded curve, as a positive fraction. */
  readonly maxDrawdown: number;
  readonly meanDaily: number;
  readonly sdDaily: number;
}

export function performance(returns: readonly DailyReturn[]): Performance {
  const n = returns.length;
  if (n === 0) {
    return {
      days: 0,
      totalReturn: 0,
      annualized: 0,
      tStat: 0,
      maxDrawdown: 0,
      meanDaily: 0,
      sdDaily: 0,
    };
  }
  let growth = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let sum = 0;
  for (const { r } of returns) {
    growth *= 1 + r;
    peak = Math.max(peak, growth);
    maxDrawdown = Math.max(maxDrawdown, 1 - growth / peak);
    sum += r;
  }
  const mean = sum / n;
  let squares = 0;
  for (const { r } of returns) squares += (r - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(squares / (n - 1)) : 0;
  return {
    days: n,
    totalReturn: growth - 1,
    annualized: growth > 0 ? growth ** (365 / n) - 1 : -1,
    tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0,
    maxDrawdown,
    meanDaily: mean,
    sdDaily: sd,
  };
}

export interface TradeStats {
  readonly count: number;
  readonly wins: number;
  readonly winRate: number;
  /** Mean net return on equity of the winners / losers. */
  readonly averageWin: number;
  readonly averageLoss: number;
  /** Mean net return on equity per trade. */
  readonly expectancy: number;
  readonly long: { readonly count: number; readonly netPnl: number };
  readonly short: { readonly count: number; readonly netPnl: number };
  readonly netPnl: number;
  readonly fees: number;
  readonly funding: number;
  readonly exits: Readonly<Partial<Record<ExitReason, number>>>;
}

export function tradeStats(trades: readonly ClosedTrade[]): TradeStats {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const mean = (values: readonly number[]) =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  const side = (direction: 'LONG' | 'SHORT') => {
    const ofSide = trades.filter((t) => t.direction === direction);
    return { count: ofSide.length, netPnl: ofSide.reduce((a, t) => a + t.netPnl, 0) };
  };
  const exits: Partial<Record<ExitReason, number>> = {};
  for (const t of trades) exits[t.exitReason] = (exits[t.exitReason] ?? 0) + 1;
  return {
    count: trades.length,
    wins: wins.length,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    averageWin: mean(wins.map((t) => t.returnOnEquity)),
    averageLoss: mean(losses.map((t) => t.returnOnEquity)),
    expectancy: mean(trades.map((t) => t.returnOnEquity)),
    long: side('LONG'),
    short: side('SHORT'),
    netPnl: trades.reduce((a, t) => a + t.netPnl, 0),
    fees: trades.reduce((a, t) => a + t.fees, 0),
    funding: trades.reduce((a, t) => a + t.funding, 0),
    exits,
  };
}
