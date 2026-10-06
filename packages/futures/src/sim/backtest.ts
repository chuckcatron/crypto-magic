import { MarketSeries } from '../series';
import type { IntradayStrategy } from '../strategies/types';
import { DAY, type Bar, type ClosedTrade, type CostModel, type DailyMark } from '../types';
import { IntradayAccount } from './intraday-account';
import { RotationAccount, type RotationOptions } from './rotation-account';

/** Every window a strategy reads fits in this much history before the first trade. */
export const WARMUP_SECONDS = 60 * DAY;

export interface AccountRun {
  readonly label: string;
  readonly initialEquity: number;
  readonly daily: readonly DailyMark[];
  readonly trades: readonly ClosedTrade[];
}

/** Index of the first bar opening at or after `t` (binary search; bars ascending). */
export function firstAtOrAfter(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * One coin, one strategy, one window. Bars from `from` minus the warmup feed the
 * indicators; trading runs on bars opening in [from, to); anything still open
 * is closed at the last close.
 */
export function runIntraday(args: {
  readonly productId: string;
  readonly bars: readonly Bar[];
  readonly strategy: IntradayStrategy;
  readonly costs: CostModel;
  readonly from: number;
  readonly to: number;
  readonly initialEquity?: number;
}): AccountRun {
  const initialEquity = args.initialEquity ?? 10_000;
  if (args.strategy.warmupM5Bars * 300 > WARMUP_SECONDS) {
    throw new Error(`${args.strategy.name} needs more warmup than ${WARMUP_SECONDS / DAY} days`);
  }
  const series = new MarketSeries();
  const account = new IntradayAccount({
    productId: args.productId,
    strategy: args.strategy,
    costs: args.costs,
    initialEquity,
    tradeFrom: args.from,
  });
  for (let i = firstAtOrAfter(args.bars, args.from - WARMUP_SECONDS); i < args.bars.length; i++) {
    const bar = args.bars[i]!;
    if (bar.t >= args.to) break;
    series.append(bar);
    account.onBar(bar, series);
  }
  account.finish();
  return {
    label: `${args.strategy.id} ${args.productId}`,
    initialEquity,
    daily: account.daily,
    trades: account.trades,
  };
}

/**
 * F4 over a window: every coin's daily bars, fed one UTC day at a time from
 * the lookback before `from`, trading on days in [from, to).
 */
export function runRotation(args: {
  readonly bars: ReadonlyMap<string, readonly Bar[]>;
  readonly costs: CostModel;
  readonly from: number;
  readonly to: number;
  readonly initialEquity?: number;
  readonly options?: Partial<RotationOptions>;
}): AccountRun & { readonly account: RotationAccount } {
  const initialEquity = args.initialEquity ?? 10_000;
  const account = new RotationAccount({
    ...args.options,
    costs: args.costs,
    initialEquity,
    tradeFrom: args.from,
  });
  const cursors = new Map<string, number>();
  for (const [productId, bars] of args.bars) {
    cursors.set(productId, firstAtOrAfter(bars, args.from - 40 * DAY));
  }
  const start = Math.floor((args.from - 40 * DAY) / DAY) * DAY;
  for (let day = start; day < args.to; day += DAY) {
    const today = new Map<string, Bar>();
    for (const [productId, bars] of args.bars) {
      let i = cursors.get(productId)!;
      while (i < bars.length && bars[i]!.t < day) i++;
      if (i < bars.length && bars[i]!.t === day) today.set(productId, bars[i]!);
      cursors.set(productId, i);
    }
    account.onDay(day, today);
  }
  account.finish();
  return {
    label: 'F4 rotation',
    initialEquity,
    daily: account.daily,
    trades: account.trades,
    account,
  };
}
