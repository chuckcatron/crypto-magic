#!/usr/bin/env node
/**
 * Build a BTC-USD candle CSV from Bitstamp's public minute history.
 *
 *   node scripts/fetch-btc-history.mjs --granularity ONE_DAY  > data/btc-daily.csv
 *   node scripts/fetch-btc-history.mjs --granularity ONE_HOUR --from 2022-11-01 > data/btc-hourly.csv
 *
 * Source: github.com/ff137/bitstamp-btcusd-minute-data — 6.8M one-minute bars,
 * Jan 2012 to Jan 2025, from a real exchange. Streams the ~89MB archive and
 * aggregates as it goes, so the 327MB uncompressed file never touches disk.
 *
 * Validated in docs/BACKTEST.md against well-known price landmarks (every one
 * within 2.6%) and against an independent investing.com series (median daily
 * close disagreement 0.23% over 2,041 overlapping days).
 */
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

const SOURCE =
  'https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz';
const BUCKET = { ONE_MINUTE: 60, FIVE_MINUTE: 300, FIFTEEN_MINUTE: 900, THIRTY_MINUTE: 1800, ONE_HOUR: 3600, TWO_HOUR: 7200, SIX_HOUR: 21600, ONE_DAY: 86400 };

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const granularity = arg('granularity') ?? 'ONE_DAY';
const step = BUCKET[granularity];
if (!step) throw new Error(`--granularity must be one of ${Object.keys(BUCKET).join(', ')}`);
const from = arg('from') ? Date.parse(`${arg('from')}T00:00:00Z`) / 1000 : 0;

const response = await fetch(SOURCE);
if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);

const lines = createInterface({ input: Readable.fromWeb(response.body).pipe(createGunzip()), crlfDelay: Infinity });
const buckets = new Map();
let header = null;
let rows = 0;

for await (const line of lines) {
  if (!header) {
    header = line.split(',').map((h) => h.trim().toLowerCase());
    continue;
  }
  const cells = line.split(',');
  const at = (name) => Number(cells[header.indexOf(name)]);
  let t = at('timestamp');
  if (t > 1e12) t = Math.floor(t / 1000);
  const [o, h, l, c, v] = [at('open'), at('high'), at('low'), at('close'), at('volume') || 0];
  if (![t, o, h, l, c].every(Number.isFinite) || c <= 0 || t < from) continue;
  rows++;

  const key = Math.floor(t / step) * step;
  const b = buckets.get(key);
  if (!b) {
    buckets.set(key, { first: t, last: t, o, h, l, c, v });
    continue;
  }
  if (t < b.first) (b.first = t), (b.o = o);
  if (t > b.last) (b.last = t), (b.c = c);
  if (h > b.h) b.h = h;
  if (l < b.l) b.l = l;
  b.v += v;
}

const out = ['timestamp,open,high,low,close,volume'];
for (const [t, b] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
  out.push([t, b.o, b.h, b.l, b.c, b.v.toFixed(4)].join(','));
}
process.stdout.write(out.join('\n') + '\n');
process.stderr.write(`${rows} minute bars -> ${buckets.size} ${granularity} bars\n`);
process.stderr.write('Note: the final bar may be a partial period; pass --to to the backtest to drop it.\n');
