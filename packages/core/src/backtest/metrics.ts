import type { BacktestMetrics, BacktestTrade, EquityPoint } from './types';

const SECONDS_PER_YEAR = 365 * 24 * 3600;

export function computeMetrics(args: {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  initialEquity: number;
  barSeconds: number;
  barsInPosition: number;
  totalBars: number;
}): BacktestMetrics {
  const { trades, equityCurve, initialEquity, barSeconds } = args;
  const finalEquity = equityCurve.at(-1)?.equity ?? initialEquity;

  const wins = trades.filter((t) => t.pnl.gt(0));
  const losses = trades.filter((t) => t.pnl.lte(0));
  const grossProfit = wins.reduce((s, t) => s + t.pnl.toNumber(), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl.toNumber(), 0));

  const totalReturnPct = initialEquity > 0 ? ((finalEquity - initialEquity) / initialEquity) * 100 : 0;

  const elapsed = elapsedSeconds(equityCurve);
  const years = elapsed / SECONDS_PER_YEAR;
  const annualizedReturnPct =
    years > 0 && initialEquity > 0 && finalEquity > 0
      ? (Math.pow(finalEquity / initialEquity, 1 / years) - 1) * 100
      : 0;

  const returns = periodReturns(equityCurve);
  const periodsPerYear = barSeconds > 0 ? SECONDS_PER_YEAR / barSeconds : 0;

  return {
    totalReturnPct: round(totalReturnPct),
    annualizedReturnPct: round(annualizedReturnPct),
    maxDrawdownPct: round(Math.max(0, ...equityCurve.map((p) => p.drawdownPct))),
    sharpeRatio: round(sharpe(returns, periodsPerYear)),
    sortinoRatio: round(sortino(returns, periodsPerYear)),
    winRate: trades.length > 0 ? round((wins.length / trades.length) * 100) : 0,
    // No losses at all is not "infinite edge", it's too small a sample. Report
    // the gross profit instead of Infinity so the number stays comparable.
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : round(grossProfit),
    expectancy: trades.length > 0 ? round((grossProfit - grossLoss) / trades.length) : 0,
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    averageWin: wins.length > 0 ? round(grossProfit / wins.length) : 0,
    averageLoss: losses.length > 0 ? round(-grossLoss / losses.length) : 0,
    largestWin: round(Math.max(0, ...trades.map((t) => t.pnl.toNumber()))),
    largestLoss: round(Math.min(0, ...trades.map((t) => t.pnl.toNumber()))),
    averageBarsHeld:
      trades.length > 0 ? round(trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length) : 0,
    exposurePct: args.totalBars > 0 ? round((args.barsInPosition / args.totalBars) * 100) : 0,
    totalFees: round(trades.reduce((s, t) => s + t.fees.toNumber(), 0)),
  };
}

function elapsedSeconds(curve: EquityPoint[]): number {
  if (curve.length < 2) return 0;
  return curve.at(-1)!.time - curve[0]!.time;
}

function periodReturns(curve: EquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]!.equity;
    if (prev > 0) out.push((curve[i]!.equity - prev) / prev);
  }
  return out;
}

function sharpe(returns: number[], periodsPerYear: number): number {
  if (returns.length < 2 || periodsPerYear <= 0) return 0;
  const mean = average(returns);
  const sd = stdev(returns, mean);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(periodsPerYear);
}

/** Like Sharpe but only penalizes downside volatility — upside spikes aren't risk. */
function sortino(returns: number[], periodsPerYear: number): number {
  if (returns.length < 2 || periodsPerYear <= 0) return 0;
  const mean = average(returns);
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return 0;
  const dd = Math.sqrt(average(downside.map((r) => r * r)));
  if (dd === 0) return 0;
  return (mean / dd) * Math.sqrt(periodsPerYear);
}

function average(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[], mean: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function round(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}
