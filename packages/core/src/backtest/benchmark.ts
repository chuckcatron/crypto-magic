import type { Candle } from '../types/market';
import { GRANULARITY_SECONDS } from '../types/market';
import type { FeeModel } from './types';

const SECONDS_PER_YEAR = 365 * 24 * 3600;

export interface Benchmark {
  readonly label: string;
  readonly finalEquity: number;
  readonly totalReturnPct: number;
  readonly annualizedReturnPct: number;
  readonly maxDrawdownPct: number;
  readonly sharpeRatio: number;
  /** Fraction of the window spent holding. Always 100 for buy-and-hold. */
  readonly exposurePct: number;
}

/**
 * Buy at the start of the tradable window, hold to the end.
 *
 * This is the benchmark that matters, and it is the one almost every crypto
 * backtest quietly omits. Bitcoin's history is dominated by a handful of
 * enormous up-moves; any long-biased strategy participating in a fraction of
 * them will show a large positive return and look like an edge. The only
 * question worth asking is whether it beat simply holding the asset — on
 * return, or on drawdown, or ideally both.
 *
 * Kept scrupulously fair to the strategy:
 *   - starts at the same bar the strategy could first have traded, so the
 *     warmup period is excluded from both;
 *   - pays the same taker fee and adverse slippage, once in and once out;
 *   - marks to market on the same bar closes.
 */
export function buyAndHold(args: {
  candles: Candle[];
  /** The first bar the strategy could have acted on. */
  startIndex: number;
  initialEquity: number;
  feeModel: FeeModel;
}): Benchmark {
  const { candles, startIndex, initialEquity, feeModel } = args;
  const window = candles.slice(startIndex);

  if (window.length < 2) {
    return {
      label: 'buy & hold',
      finalEquity: initialEquity,
      totalReturnPct: 0,
      annualizedReturnPct: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      exposurePct: 100,
    };
  }

  const slip = feeModel.slippageBps / 10_000;
  const fee = feeModel.takerBps / 10_000;

  // Enter at the first bar's open, exactly as the strategy's fills do.
  const entryPrice = window[0]!.open * (1 + slip);
  const spend = initialEquity / (1 + fee);
  const units = spend / entryPrice;

  let peak = initialEquity;
  let maxDrawdownPct = 0;
  const equityCurve: number[] = [];

  for (const bar of window) {
    const equity = units * bar.close;
    equityCurve.push(equity);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }

  // Exit at the last close, paying the round trip's second leg.
  const exitPrice = window.at(-1)!.close * (1 - slip);
  const finalEquity = units * exitPrice * (1 - fee);

  const barSeconds = GRANULARITY_SECONDS[window[0]!.granularity];
  const years = ((window.length - 1) * barSeconds) / SECONDS_PER_YEAR;

  return {
    label: 'buy & hold',
    finalEquity: round2(finalEquity),
    totalReturnPct: round2(((finalEquity - initialEquity) / initialEquity) * 100),
    annualizedReturnPct:
      years > 0 && finalEquity > 0
        ? round2((Math.pow(finalEquity / initialEquity, 1 / years) - 1) * 100)
        : 0,
    maxDrawdownPct: round2(maxDrawdownPct),
    sharpeRatio: round2(sharpe(equityCurve, barSeconds)),
    exposurePct: 100,
  };
}

function sharpe(equity: number[], barSeconds: number): number {
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    if (prev > 0) returns.push((equity[i]! - prev) / prev);
  }
  if (returns.length < 2) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(SECONDS_PER_YEAR / barSeconds);
}

function round2(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}
