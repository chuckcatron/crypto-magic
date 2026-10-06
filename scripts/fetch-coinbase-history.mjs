#!/usr/bin/env node
/**
 * Build a candle CSV for any Coinbase product, from Coinbase's PUBLIC
 * market-data endpoint. No API key.
 *
 *   node scripts/fetch-coinbase-history.mjs --product ETH-USD > data/eth-daily.csv
 *   node scripts/fetch-coinbase-history.mjs --product SOL-USD --from 2021-06-01 > data/sol-daily.csv
 *   node scripts/fetch-coinbase-history.mjs --product BTC-USD --granularity FIVE_MINUTE \
 *     --from 2018-10-01 --to 2026-10-01 > data/btc-5m.csv
 *
 * For coins other than BTC, which has a longer, validated Bitstamp series (see
 * scripts/fetch-btc-history.mjs). History starts when Coinbase listed the
 * product, so it is short for newer coins. Only CLOSED bars are written: the
 * current bar is still moving and would leak a price the strategy could not
 * have known.
 *
 * Output columns match what `pnpm backtest -- --csv` reads. Missing bars are
 * reported on stderr rather than filled in. Coinbase writes no candle for an
 * interval with no trades, so a few are normal at five minutes.
 *
 * Behind a proxy, Node's fetch needs NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */

const API = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const GRANULARITY_SECONDS = {
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1800,
  ONE_HOUR: 3600,
  TWO_HOUR: 7200,
  SIX_HOUR: 21_600,
  ONE_DAY: 86_400,
};
// The endpoint returns at most 350 candles per request.
const PAGE = 300;
// A long intraday fetch is thousands of requests; stay well under the public limit.
const REQUEST_SPACING_MS = 100;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(message) {
  console.error(message);
  console.error(
    'usage: fetch-coinbase-history.mjs --product ETH-USD [--granularity ONE_DAY] [--from 2016-01-01] [--to 2026-10-01]',
  );
  process.exit(1);
}

function parseDate(name) {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const seconds = Math.floor(Date.parse(`${raw}T00:00:00Z`) / 1000);
  if (!Number.isFinite(seconds)) usage(`--${name} must be a date like 2016-01-01`);
  return seconds;
}

const product = (arg('product') ?? '').toUpperCase();
if (!/^[A-Z0-9]+(-[A-Z0-9]+)+$/.test(product)) usage('--product is required');
const granularity = (arg('granularity') ?? 'ONE_DAY').toUpperCase();
const step = GRANULARITY_SECONDS[granularity];
if (!step) usage(`--granularity must be one of ${Object.keys(GRANULARITY_SECONDS).join(', ')}`);
const fromArg = parseDate('from');
const from = fromArg ?? 0;
const toArg = parseDate('to');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function page(start, end) {
  const url = `${API}/${product}/candles?granularity=${granularity}&start=${start}&end=${end}&limit=${PAGE}`;
  for (let attempt = 1; ; attempt++) {
    let status;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) return (await response.json()).candles ?? [];
      status = response.status;
      // Public endpoints rate-limit; back off rather than fail a long fetch.
      if (status !== 429 && status < 500) {
        throw new Error(`${url} returned ${status}: ${await response.text()}`);
      }
    } catch (error) {
      // A non-retryable status was thrown above; anything else (a timeout, a
      // reset connection, a truncated body) is a read and safe to retry.
      if (status !== undefined && status !== 429 && status < 500) throw error;
      status ??= String(error);
    }
    if (attempt >= 6) throw new Error(`${url} failed ${attempt} times; last: ${status}`);
    await sleep(1000 * 2 ** attempt);
  }
}

const now = Math.floor(Date.now() / 1000);
// Open time of the newest bar that has fully closed, and of the last one wanted.
const lastClosedStart = Math.floor(now / step) * step - step;
const lastWanted = toArg === undefined ? lastClosedStart : Math.min(lastClosedStart, toArg - step);
const byTime = new Map();
let end = lastWanted + step;

// Walk backwards a page at a time. With --from, cover the whole range even if a
// page comes back empty (an exchange outage); without it, stop at the first
// empty page, which is where Coinbase's history for the product begins.
while (end > from) {
  const start = Math.max(from, end - PAGE * step);
  const candles = await page(start, end);
  if (candles.length === 0 && fromArg === undefined) break;
  for (const c of candles) {
    const t = Number(c.start);
    if (t >= from && t <= lastWanted) byTime.set(t, c);
  }
  end = start;
  process.stderr.write(`\r${product}: ${byTime.size} bars...`);
  await sleep(REQUEST_SPACING_MS);
}
process.stderr.write('\n');

const times = [...byTime.keys()].sort((a, b) => a - b);
if (times.length === 0) {
  console.error(`no candles returned for ${product}`);
  process.exit(1);
}

let missing = 0;
for (let i = 1; i < times.length; i++) missing += (times[i] - times[i - 1]) / step - 1;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, step < 86_400 ? 16 : 10);
process.stderr.write(
  `${product}: ${times.length} ${granularity} bars, ${iso(times[0])} → ${iso(times.at(-1))}, ${missing} missing\n`,
);

const lines = ['timestamp,open,high,low,close,volume'];
for (const t of times) {
  const c = byTime.get(t);
  lines.push([t, c.open, c.high, c.low, c.close, c.volume].join(','));
}
process.stdout.write(`${lines.join('\n')}\n`);
