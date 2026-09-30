#!/usr/bin/env node
/**
 * Combine single-coin backtests into an equal-weight portfolio, and compare it
 * with a reference at the same drawdown. Used by EXPERIMENT-006.
 *
 *   node scripts/combine-sleeves.mjs --reference btc.json --mix btc.json,eth.json,sol.json
 *
 * Each input is a `run-backtest.ts --json` result over the same window. The mix
 * gives every coin an equal slice of the starting money and never rebalances
 * ("sleeves"): each slice compounds on its own. The comparison scales the
 * reference down with idle cash (x in the reference, the rest in cash at 0%,
 * rebalanced to x every bar) until its maximum drawdown equals the mix's, the same
 * question EXPERIMENT-001 asked: at the same risk, which earns more?
 *
 * Annualized return and drawdown follow packages/core/src/backtest/metrics.ts:
 * the starting equity against the last point of the equity curve, over the
 * curve's first-to-last time, with a 365-day year.
 */
import { readFileSync } from 'node:fs';

const SECONDS_PER_YEAR = 365 * 24 * 3600;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function load(path) {
  const result = JSON.parse(readFileSync(path, 'utf8'));
  return {
    name: `${result.productId} ${result.strategy}`,
    initial: result.initialEquity,
    curve: result.equityCurve.map((p) => ({ time: p.time, equity: p.equity })),
    reported: result.metrics,
  };
}

function metrics(initial, curve) {
  let peak = initial;
  let maxDrawdown = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDrawdown = Math.max(maxDrawdown, ((peak - p.equity) / peak) * 100);
  }
  const years = (curve.at(-1).time - curve[0].time) / SECONDS_PER_YEAR;
  const final = curve.at(-1).equity;
  const annualized = years > 0 && final > 0 ? ((final / initial) ** (1 / years) - 1) * 100 : 0;
  const returns = curve.slice(1).map((p, i) => p.equity / curve[i].equity - 1);
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1));
  return { annualized, maxDrawdown, sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0 };
}

function assertAligned(sleeves) {
  const times = sleeves[0].curve.map((p) => p.time);
  for (const s of sleeves) {
    if (s.curve.length !== times.length || s.curve.some((p, i) => p.time !== times[i])) {
      throw new Error(`${s.name}: equity curve does not line up with ${sleeves[0].name}`);
    }
    if (s.initial !== sleeves[0].initial)
      throw new Error('every input must start with the same equity');
  }
}

/** Equal slices at the start, each compounding on its own. */
function mix(sleeves) {
  assertAligned(sleeves);
  const initial = sleeves[0].initial;
  const curve = sleeves[0].curve.map((p, i) => ({
    time: p.time,
    equity: sleeves.reduce((sum, s) => sum + s.curve[i].equity, 0) / sleeves.length,
  }));
  return { name: `equal-weight ${sleeves.length}-coin mix`, initial, curve };
}

/** x of the account in the reference, the rest idle in cash. */
/**
 * x of the account in the reference, the rest idle in cash, rebalanced to x
 * every bar, so each day's return is x times the reference's.
 *
 * EXPERIMENT-006 and 007 set x once and never rebalanced. Over a window where
 * the reference grows many times over, that slice comes to dominate the account
 * and inherits nearly all of its drawdown: in EXPERIMENT-007's window 1 a 1.7%
 * slice of a strategy that grew 58x showed a 51% drawdown. EXPERIMENT-006 only
 * compared at x = 1, where the two methods are identical.
 */
function scaled(reference, x) {
  const curve = [];
  let equity = reference.initial;
  let previous = reference.initial;
  for (const p of reference.curve) {
    equity *= 1 + x * (p.equity / previous - 1);
    previous = p.equity;
    curve.push({ time: p.time, equity });
  }
  return curve;
}

const referencePath = arg('reference');
const mixPaths = arg('mix')?.split(',');
if (!referencePath || !mixPaths?.length) {
  console.error('usage: combine-sleeves.mjs --reference a.json --mix a.json,b.json,c.json');
  process.exit(1);
}

const reference = load(referencePath);
const sleeves = mixPaths.map(load);
const portfolio = mix(sleeves);
assertAligned([reference, ...sleeves]);

const fmt = (m) =>
  `annualized ${m.annualized.toFixed(2).padStart(7)}%   max drawdown -${m.maxDrawdown.toFixed(2).padStart(5)}%   sharpe ${m.sharpe.toFixed(2)}`;

console.log('Inputs (recomputed here; the backtester reported in brackets):');
const listed = [referencePath, ...mixPaths.filter((p) => p !== referencePath)].map(load);
for (const s of listed) {
  const m = metrics(s.initial, s.curve);
  console.log(
    `  ${s.name.padEnd(28)} ${fmt(m)}   [${s.reported.annualizedReturnPct}%, -${s.reported.maxDrawdownPct}%]`,
  );
}

const mixed = metrics(portfolio.initial, portfolio.curve);
const ref = metrics(reference.initial, reference.curve);
console.log(`\n  ${portfolio.name.padEnd(28)} ${fmt(mixed)}`);
console.log(`  ${`reference: ${reference.name}`.padEnd(28)} ${fmt(ref)}`);

let comparison;
if (mixed.maxDrawdown >= ref.maxDrawdown) {
  comparison = { fraction: 1, ...ref };
} else {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (metrics(reference.initial, scaled(reference, mid)).maxDrawdown < mixed.maxDrawdown)
      lo = mid;
    else hi = mid;
  }
  const fraction = (lo + hi) / 2;
  comparison = { fraction, ...metrics(reference.initial, scaled(reference, fraction)) };
}

const label = `${(comparison.fraction * 100).toFixed(1)}% reference, rest cash`;
console.log(`  ${label.padEnd(28)} ${fmt(comparison)}`);
// Rounded as reported, so a difference too small to print is a tie, not a win.
const margin = Math.round((mixed.annualized - comparison.annualized) * 100) / 100;
const verdict = margin > 0 ? 'MIX BETTER' : margin < 0 ? 'REFERENCE BETTER' : 'TIE';
console.log(
  `\n${verdict}: at the same drawdown the mix's annualized return was ${margin >= 0 ? '+' : ''}${margin.toFixed(2)} points against the reference's.`,
);
