import { DAY, type DailyMark } from '@crypto-magic/futures';

/** One sub-account's equity: its strategy, its marks at UTC day closes, and its equity now. */
export interface EquitySource {
  readonly strategy: string;
  /** Ascending by day. A mark's `day` is that day's 00:00 UTC; it holds equity at the day's close. */
  readonly daily: readonly DailyMark[];
  readonly equity: number;
}

/** Paper P&L, in dollars, at UNIX second `t`. */
export interface PnlPoint {
  readonly t: number;
  readonly pnl: number;
}

export interface StrategyPnl {
  readonly strategy: string;
  /** How many sub-accounts are summed into it. */
  readonly accounts: number;
  readonly points: readonly PnlPoint[];
}

/**
 * Each strategy's paper P&L over time, for the dashboard's chart: zero when the
 * engine first started, then at every UTC day close since, then now.
 *
 * A strategy's sub-accounts are summed. A sub-account with no mark at some
 * close counts at its latest earlier mark, or at its starting equity before its
 * first. Strategies come out in the order they first appear in `sources`.
 */
export function pnlHistory(
  sources: readonly EquitySource[],
  initialEquity: number,
  startedAt: number,
  now: number,
): StrategyPnl[] {
  const groups = new Map<string, EquitySource[]>();
  for (const source of sources) {
    const group = groups.get(source.strategy);
    if (group) group.push(source);
    else groups.set(source.strategy, [source]);
  }

  return [...groups].map(([strategy, group]) => {
    const base = group.length * initialEquity;
    const current = group.reduce((sum, s) => sum + s.equity, 0) - base;
    if (now <= startedAt) {
      return { strategy, accounts: group.length, points: [{ t: startedAt, pnl: current }] };
    }

    const closes = new Set<number>();
    for (const source of group) {
      for (const mark of source.daily) {
        const close = mark.day + DAY;
        if (close > startedAt && close < now) closes.add(close);
      }
    }
    const points: PnlPoint[] = [{ t: startedAt, pnl: 0 }];
    for (const close of [...closes].sort((a, b) => a - b)) {
      const equity = group.reduce((sum, s) => sum + equityAt(s.daily, close, initialEquity), 0);
      points.push({ t: close, pnl: equity - base });
    }
    points.push({ t: now, pnl: current });
    return { strategy, accounts: group.length, points };
  });
}

/** Equity at the latest mark whose day closed at or before `close`. */
function equityAt(daily: readonly DailyMark[], close: number, initialEquity: number): number {
  let equity = initialEquity;
  for (const mark of daily) {
    if (mark.day + DAY > close) break;
    equity = mark.equity;
  }
  return equity;
}
