#!/usr/bin/env node
/**
 * Volatility-targeted sizing applied to a regime-filter backtest. Used by
 * EXPERIMENT-010 (docs/EXPERIMENT-010-volatility-targeted-sizing.md).
 *
 *   node scripts/vol-target.mjs --baseline w1-base.json --csv data/btc-daily.csv \
 *     --out w1-v50.json
 *
 * Takes a `run-backtest.ts --json` result and the CSV it was run on, and
 * re-weights the baseline's bar-by-bar returns. The output has the same shape,
 * so `combine-sleeves.mjs --reference <baseline> --mix <output>` compares them.
 *
 * Weight while in the market: min(1, target / sigma), sigma being the standard
 * deviation of the previous `window` daily log returns of the close, times
 * sqrt(365). The weight is set at entry and changes afterwards only when the
 * new one differs from the held one by more than `band`. A resize pays
 * `resizeBps` on the notional it trades. The baseline's own entry and exit
 * costs are inside its returns, so they scale with the weight held.
 *
 * No lookahead: the weight for the interval starting at a curve point uses only
 * closes of bars that started before that point, so closed before it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DAY = 86_400;
const SECONDS_PER_YEAR = 365 * DAY;

export const DEFAULTS = { target: 0.5, window: 30, band: 0.1, resizeBps: 65 };

/** Daily closes as [{time, close}], oldest first. */
export function loadCloses(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const t = header.indexOf('timestamp');
  const c = header.indexOf('close');
  if (t < 0 || c < 0) throw new Error(`${path}: expected timestamp and close columns`);
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return { time: Number(cells[t]), close: Number(cells[c]) };
  });
}

/** Annualized sigma from the `window` log returns of the closes ending at the last bar before `before`. */
export function sigmaBefore(closes, before, window) {
  let end = closes.length - 1;
  while (end >= 0 && closes[end].time >= before) end--;
  if (end < window) throw new Error(`fewer than ${window + 1} closes before ${before}`);
  const returns = [];
  for (let i = end - window + 1; i <= end; i++) {
    returns.push(Math.log(closes[i].close / closes[i - 1].close));
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365);
}

/** Maximum drawdown (percent) and annualized return (percent), as combine-sleeves computes them. */
export function summarize(initial, curve) {
  let peak = initial;
  let maxDrawdown = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDrawdown = Math.max(maxDrawdown, ((peak - p.equity) / peak) * 100);
  }
  const years = (curve.at(-1).time - curve[0].time) / SECONDS_PER_YEAR;
  const final = curve.at(-1).equity;
  const annualized = years > 0 && final > 0 ? ((final / initial) ** (1 / years) - 1) * 100 : 0;
  return { annualizedReturnPct: annualized, maxDrawdownPct: maxDrawdown };
}

/**
 * @param baseline a run-backtest --json result
 * @param closes   loadCloses() of the same CSV
 */
export function volTarget(baseline, closes, options = {}) {
  const { target, window, band, resizeBps } = { ...DEFAULTS, ...options };
  const initial = baseline.initialEquity;
  const source = baseline.equityCurve;

  let equity = initial;
  let held = 0;
  let resizes = 0;
  let resizeFees = 0;
  const curve = [{ time: source[0].time, equity }];
  const weights = [{ time: source[0].time, weight: 0 }];
  let heldIntervals = 0;
  let weightSum = 0;

  for (let i = 1; i < source.length; i++) {
    const prev = source[i - 1];
    const cur = source[i];
    // An interval is in the market if the baseline holds at either end of it:
    // the entry interval ends with a position, the exit interval starts with one.
    const inMarket = prev.positionValue > 0 || cur.positionValue > 0;

    let weight = 0;
    if (inMarket) {
      const sigma = sigmaBefore(closes, prev.time, window);
      const wanted = sigma > 0 ? Math.min(1, target / sigma) : 1;
      if (held === 0) {
        held = wanted;
      } else if (Math.abs(wanted - held) > band) {
        const fee = (Math.abs(wanted - held) * equity * resizeBps) / 10_000;
        equity -= fee;
        resizeFees += fee;
        resizes++;
        held = wanted;
      }
      weight = held;
      heldIntervals++;
      weightSum += weight;
      equity *= 1 + weight * (cur.equity / prev.equity - 1);
    }
    if (!(cur.positionValue > 0)) held = 0;
    curve.push({ time: cur.time, equity });
    weights.push({ time: cur.time, weight });
  }

  const metrics = summarize(initial, curve);
  return {
    strategy: `${baseline.strategy}-vt${Math.round(target * 100)}`,
    productId: baseline.productId,
    initialEquity: initial,
    finalEquity: equity,
    equityCurve: curve,
    weights,
    metrics: {
      annualizedReturnPct: Number(metrics.annualizedReturnPct.toFixed(4)),
      maxDrawdownPct: Number(metrics.maxDrawdownPct.toFixed(2)),
    },
    context: {
      options: { target, window, band, resizeBps },
      averageWeight: heldIntervals ? weightSum / heldIntervals : 0,
      timeInMarketPct: (heldIntervals / (source.length - 1)) * 100,
      resizes,
      resizeFees,
    },
  };
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baselinePath = arg('baseline');
  const csvPath = arg('csv');
  const outPath = arg('out');
  if (!baselinePath || !csvPath || !outPath) {
    console.error('usage: vol-target.mjs --baseline base.json --csv data.csv --out variant.json');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const result = volTarget(baseline, loadCloses(csvPath));
  writeFileSync(outPath, JSON.stringify(result));
  const base = summarize(baseline.initialEquity, baseline.equityCurve);
  const c = result.context;
  console.log(
    `${result.strategy}: annualized ${result.metrics.annualizedReturnPct.toFixed(2)}%  max drawdown -${result.metrics.maxDrawdownPct.toFixed(2)}%` +
      `  (baseline ${base.annualizedReturnPct.toFixed(2)}% / -${base.maxDrawdownPct.toFixed(2)}%)\n` +
      `average weight ${c.averageWeight.toFixed(3)}  time in market ${c.timeInMarketPct.toFixed(1)}%  resizes ${c.resizes}  resize fees ${c.resizeFees.toFixed(2)}`,
  );
}
