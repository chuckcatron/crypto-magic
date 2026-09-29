#!/usr/bin/env node
/**
 * Build a daily candle CSV for any Coinbase product, from Coinbase's PUBLIC
 * market-data endpoint. No API key.
 *
 *   node scripts/fetch-coinbase-history.mjs --product ETH-USD > data/eth-daily.csv
 *   node scripts/fetch-coinbase-history.mjs --product SOL-USD --from 2021-06-01 > data/sol-daily.csv
 *
 * For coins other than BTC, which has a longer, validated Bitstamp series (see
 * scripts/fetch-btc-history.mjs). History starts when Coinbase listed the
 * product, so it is short for newer coins. Only CLOSED bars are written: today's
 * bar is still moving and would leak a price the strategy could not have known.
 *
 * Output columns match what `pnpm backtest -- --csv` reads. Missing days are
 * reported on stderr rather than filled in.
 */

const API = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const DAY = 86_400;
// The endpoint returns at most 350 candles per request.
const PAGE = 300;

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const product = (arg('product') ?? '').toUpperCase();
if (!/^[A-Z0-9]+-[A-Z]+$/.test(product)) {
  console.error('usage: fetch-coinbase-history.mjs --product ETH-USD [--from 2016-01-01]');
  process.exit(1);
}
const from = arg('from') ? Math.floor(Date.parse(`${arg('from')}T00:00:00Z`) / 1000) : 0;
if (!Number.isFinite(from)) {
  console.error('--from must be a date like 2016-01-01');
  process.exit(1);
}

async function page(start, end) {
  const url = `${API}/${product}/candles?granularity=ONE_DAY&start=${start}&end=${end}&limit=${PAGE}`;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (response.ok) return (await response.json()).candles ?? [];
    // Public endpoints rate-limit; back off rather than fail a long fetch.
    if (attempt >= 5 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

const now = Math.floor(Date.now() / 1000);
const lastClosedStart = Math.floor(now / DAY) * DAY - DAY;
const byTime = new Map();
let end = lastClosedStart + DAY;

// Walk backwards a page at a time until Coinbase has nothing older.
while (end > from) {
  const start = Math.max(from, end - PAGE * DAY);
  const candles = await page(start, end);
  if (candles.length === 0) break;
  for (const c of candles) {
    const t = Number(c.start);
    if (t >= from && t <= lastClosedStart) byTime.set(t, c);
  }
  end = start;
  process.stderr.write(`\r${product}: ${byTime.size} days...`);
}
process.stderr.write('\n');

const times = [...byTime.keys()].sort((a, b) => a - b);
if (times.length === 0) {
  console.error(`no candles returned for ${product}`);
  process.exit(1);
}

let missing = 0;
for (let i = 1; i < times.length; i++) missing += (times[i] - times[i - 1]) / DAY - 1;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
process.stderr.write(
  `${product}: ${times.length} daily bars, ${iso(times[0])} → ${iso(times.at(-1))}, ${missing} missing day(s)\n`,
);

const lines = ['timestamp,open,high,low,close,volume'];
for (const t of times) {
  const c = byTime.get(t);
  lines.push([t, c.open, c.high, c.low, c.close, c.volume].join(','));
}
process.stdout.write(`${lines.join('\n')}\n`);
