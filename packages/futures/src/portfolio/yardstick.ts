import { DAY, type DailyMark } from '../types';
import { performance, returnsFromMarks, type Performance } from '../sim/metrics';
import type { DailyMarket } from './market';

/**
 * EXPERIMENT-001's yardstick for a multi-coin market: a fixed fraction of
 * equity in the venue's BTC, the rest in cash at 0%, bought at the first open,
 * rebalanced at each month's first open and sold at the last close, paying the
 * same cost per fill as the strategies. Daily marks, as the strategies have.
 */
export function fixedBtcAllocation(args: {
  readonly market: DailyMarket;
  readonly btcSymbol: string;
  readonly fraction: number;
  readonly fillBps: number;
  readonly from: number;
  readonly to: number;
  readonly initialEquity?: number;
}): DailyMark[] {
  const { market, btcSymbol } = args;
  const fraction = Math.min(1, Math.max(0, args.fraction));
  const cost = args.fillBps / 10_000;
  let cash = args.initialEquity ?? 10_000;
  let btc = 0;
  let lastPrice = 0;
  const daily: DailyMark[] = [];

  const rebalance = (price: number) => {
    const equity = cash + btc * price;
    const delta = equity * fraction - btc * price;
    if (delta > 0) {
      const affordable = Math.min(delta, cash / (1 + cost));
      cash -= affordable * (1 + cost);
      btc += affordable / price;
    } else if (delta < 0) {
      cash += -delta * (1 - cost);
      btc += delta / price;
    }
  };

  for (let day = args.from; day < args.to; day += DAY) {
    const bar = market.bar(btcSymbol, day);
    if (bar) {
      const firstDay = day === args.from;
      const firstOfMonth = new Date(day * 1000).getUTCDate() === 1;
      if (firstDay || firstOfMonth) rebalance(bar.o);
      lastPrice = bar.c;
    }
    daily.push({ day, equity: cash + btc * lastPrice });
  }
  if (daily.length > 0) {
    cash += btc * lastPrice * (1 - cost);
    btc = 0;
    daily[daily.length - 1] = { day: daily.at(-1)!.day, equity: cash };
  }
  return daily;
}

export interface MatchedAllocation {
  readonly fraction: number;
  readonly performance: Performance;
}

/**
 * The fixed BTC allocation whose maximum drawdown equals `targetDrawdown`.
 * Drawdown rises with the fraction, so bisection finds it. If the target is
 * deeper than holding BTC outright, the answer is 100%: the strategy must then
 * beat holding BTC.
 */
export function matchedBtcAllocation(args: {
  readonly market: DailyMarket;
  readonly btcSymbol: string;
  readonly targetDrawdown: number;
  readonly fillBps: number;
  readonly from: number;
  readonly to: number;
  readonly initialEquity?: number;
}): MatchedAllocation {
  const initialEquity = args.initialEquity ?? 10_000;
  const run = (fraction: number): MatchedAllocation => ({
    fraction,
    performance: performance(
      returnsFromMarks(fixedBtcAllocation({ ...args, fraction, initialEquity }), initialEquity),
    ),
  });
  const full = run(1);
  if (args.targetDrawdown >= full.performance.maxDrawdown) return full;
  if (args.targetDrawdown <= 0) return run(0);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (run(mid).performance.maxDrawdown < args.targetDrawdown) lo = mid;
    else hi = mid;
  }
  return run((lo + hi) / 2);
}
