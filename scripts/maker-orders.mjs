#!/usr/bin/env node
/**
 * Maker limit orders against market orders, on a trade tape. Used by
 * EXPERIMENT-011 (docs/EXPERIMENT-011-maker-orders.md).
 *
 *   node scripts/maker-orders.mjs --symbol BTCUSDT --out /tmp/e11/BTCUSDT.json
 *
 * Reads data/trade-windows/<SYMBOL>-<YYYY-MM>.csv, written by
 * scripts/fetch-binance-trade-windows.sh (ts_us,price,qty,is_buyer_maker).
 *
 * For each UTC midnight M, a buy and a sell are simulated:
 *   P_ref  first trade at or after M (stand-in for the next open); a market order
 *          fills here and pays 65 bps
 *   P0     last trade before M; the limit is placed here
 *   fill   (strict) a buy fills when a trade in [M, M + 60 min) prints below P0,
 *          a sell when one prints above it. The optimistic rule also counts a
 *          trade at P0.
 *   filled pays 40 bps at P0; unfilled crosses at the first trade at or after
 *          M + 60 min and pays 65 bps.
 * Cost is measured against P_ref in bps; saving = 65 - cost.
 */
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const US = 1_000_000;
const DAY = 86_400 * US;
const WAIT = 3_600 * US;
const PRE = 600 * US;
const POST = 4_200 * US;

export const FEES = { makerBps: 40, takerBps: 60, slippageBps: 5 };
const MARKET_BPS = FEES.takerBps + FEES.slippageBps;

/** One accumulator per event midnight. */
function emptyDay() {
  return {
    p0: null, // price of the last trade before M
    p0Ts: -Infinity,
    pRef: null, // price of the first trade at or after M
    pRefTs: Infinity,
    pH: null, // price of the first trade at or after M + WAIT
    pHTs: Infinity,
    strictBuy: false, // a trade strictly below P0 inside the hour
    strictSell: false,
    touchBuy: false, // a trade at or below P0
    touchSell: false,
    below: [], // trades inside the hour, kept only until p0 is final
  };
}

/**
 * @param rows        iterable of [ts_us, price] in any order
 * @param firstMid    first event midnight (us)
 * @param lastMid     last event midnight (us), plus one more day is read for returns
 */
export async function accumulate(rows, firstMid, lastMid) {
  const days = new Map();
  const get = (m) => {
    let d = days.get(m);
    if (!d) days.set(m, (d = emptyDay()));
    return d;
  };
  const inRange = (m) => m >= firstMid && m <= lastMid + DAY;

  // Pass 1 collects P0, P_ref and P_H; trades inside the hour are kept so the
  // fill test can run once P0 is final (rows are not assumed to be in order).
  for await (const [ts, price] of rows) {
    const mid = ts - (ts % DAY);
    const offset = ts - mid;
    if (offset >= DAY - PRE) {
      const m = mid + DAY;
      if (!inRange(m)) continue;
      const d = get(m);
      if (ts > d.p0Ts) {
        d.p0Ts = ts;
        d.p0 = price;
      }
    } else if (offset <= POST) {
      if (!inRange(mid)) continue;
      const d = get(mid);
      if (ts < d.pRefTs) {
        d.pRefTs = ts;
        d.pRef = price;
      }
      if (offset >= WAIT && ts < d.pHTs) {
        d.pHTs = ts;
        d.pH = price;
      }
      if (offset < WAIT) d.below.push(price);
    }
  }
  for (const d of days.values()) {
    if (d.p0 === null) continue;
    for (const price of d.below) {
      if (price < d.p0) d.strictBuy = true;
      if (price > d.p0) d.strictSell = true;
      if (price <= d.p0) d.touchBuy = true;
      if (price >= d.p0) d.touchSell = true;
    }
    d.below = [];
  }
  return days;
}

/** Costs in bps against P_ref for one side under one fill rule. */
export function sideCost(side, d, filled) {
  const maker = FEES.makerBps / 10_000;
  const market = MARKET_BPS / 10_000;
  if (side === 'buy') {
    const paid = filled ? d.p0 * (1 + maker) : d.pH * (1 + market);
    return ((paid - d.pRef) / d.pRef) * 10_000;
  }
  const received = filled ? d.p0 * (1 - maker) : d.pH * (1 - market);
  return ((d.pRef - received) / d.pRef) * 10_000;
}

/** One record per event day from firstMid to lastMid, throwing on any gap. */
export function events(days, firstMid, lastMid) {
  const out = [];
  for (let m = firstMid; m <= lastMid; m += DAY) {
    const d = days.get(m);
    const next = days.get(m + DAY);
    if (!d || d.p0 === null || d.pRef === null || d.pH === null || !next || next.pRef === null) {
      throw new Error(`missing data for ${new Date(m / 1000).toISOString().slice(0, 10)}`);
    }
    const dayReturn = next.pRef / d.pRef - 1;
    const rec = { date: new Date(m / 1000).toISOString().slice(0, 10), dayReturn };
    for (const rule of ['strict', 'touch']) {
      const buyFilled = rule === 'strict' ? d.strictBuy : d.touchBuy;
      const sellFilled = rule === 'strict' ? d.strictSell : d.touchSell;
      rec[rule] = {
        buyFilled,
        sellFilled,
        buySaving: MARKET_BPS - sideCost('buy', d, buyFilled),
        sellSaving: MARKET_BPS - sideCost('sell', d, sellFilled),
      };
    }
    out.push(rec);
  }
  return out;
}

/** mulberry32, so the bootstrap is reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Mean and 95% interval of day-level values, resampling days. */
export function bootstrap(values, resamples = 10_000, seed = 1) {
  const random = rng(seed);
  const n = values.length;
  const means = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(random() * n)];
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  return {
    mean: mean(values),
    lo: means[Math.floor(0.025 * resamples)],
    hi: means[Math.floor(0.975 * resamples)],
  };
}

export const HALVES = {
  development: ['2025-10-01', '2026-03-31'],
  holdout: ['2026-04-01', '2026-09-29'],
};

export function summarize(records, rule) {
  const out = {};
  for (const [name, [from, to]] of Object.entries(HALVES)) {
    const half = records.filter((r) => r.date >= from && r.date <= to);
    const daily = half.map((r) => (r[rule].buySaving + r[rule].sellSaving) / 2);
    const ci = bootstrap(daily);
    const filledBuys = half.filter((r) => r[rule].buyFilled);
    const filledSells = half.filter((r) => r[rule].sellFilled);
    const crossedBuys = half.filter((r) => !r[rule].buyFilled);
    const crossedSells = half.filter((r) => !r[rule].sellFilled);
    const avg = (xs, f) => (xs.length ? mean(xs.map(f)) : null);
    const up = half.filter((r) => r.dayReturn > 0.02);
    const down = half.filter((r) => r.dayReturn < -0.02);
    out[name] = {
      days: half.length,
      meanSavingBps: ci.mean,
      ci95: [ci.lo, ci.hi],
      passesCell: ci.mean >= 5 && ci.lo > 0,
      buyFillRate: filledBuys.length / half.length,
      sellFillRate: filledSells.length / half.length,
      buySavingFilled: avg(filledBuys, (r) => r[rule].buySaving),
      buySavingCrossed: avg(crossedBuys, (r) => r[rule].buySaving),
      sellSavingFilled: avg(filledSells, (r) => r[rule].sellSaving),
      sellSavingCrossed: avg(crossedSells, (r) => r[rule].sellSaving),
      buySavingOnUpDays: avg(up, (r) => r[rule].buySaving),
      upDays: up.length,
      sellSavingOnDownDays: avg(down, (r) => r[rule].sellSaving),
      downDays: down.length,
    };
  }
  return out;
}

async function* tape(symbol, dir) {
  const months = ['2025-09', '2025-10', '2025-11', '2025-12'];
  for (let m = 1; m <= 9; m++) months.push(`2026-${String(m).padStart(2, '0')}`);
  for (const month of months) {
    const path = `${dir}/${symbol}-${month}.csv`;
    if (!existsSync(path)) throw new Error(`missing ${path}`);
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      const a = line.indexOf(',');
      const b = line.indexOf(',', a + 1);
      yield [Number(line.slice(0, a)), Number(line.slice(a + 1, b))];
    }
  }
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const symbol = arg('symbol');
  const outPath = arg('out');
  const dir = arg('dir') ?? new URL('../data/trade-windows', import.meta.url).pathname;
  if (!symbol || !outPath) {
    console.error('usage: maker-orders.mjs --symbol BTCUSDT --out result.json [--dir path]');
    process.exit(1);
  }
  const firstMid = Date.UTC(2025, 9, 1) * 1000;
  const lastMid = Date.UTC(2026, 8, 29) * 1000;
  const days = await accumulate(tape(symbol, dir), firstMid, lastMid);
  const records = events(days, firstMid, lastMid);
  const result = {
    symbol,
    fees: FEES,
    waitMinutes: 60,
    days: records.length,
    strict: summarize(records, 'strict'),
    touch: summarize(records, 'touch'),
    records,
  };
  writeFileSync(outPath, JSON.stringify(result));
  const f = (x) => (x === null ? '   n/a' : x.toFixed(1).padStart(6));
  for (const rule of ['strict', 'touch']) {
    for (const [name, s] of Object.entries(result[rule])) {
      console.log(
        `${symbol} ${rule.padEnd(6)} ${name.padEnd(11)} days ${s.days}  saving ${f(s.meanSavingBps)} bps  95% [${f(s.ci95[0])}, ${f(s.ci95[1])}]` +
          `  fill buy ${(s.buyFillRate * 100).toFixed(0)}% sell ${(s.sellFillRate * 100).toFixed(0)}%  ${s.passesCell ? 'cell PASS' : 'cell fail'}`,
      );
    }
  }
}
