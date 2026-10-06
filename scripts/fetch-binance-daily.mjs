#!/usr/bin/env node
/**
 * Download daily candles for every USDT pair in Binance's public data archive,
 * delisted pairs included, for EXPERIMENT-009. Research data only: nothing
 * here touches an account.
 *
 *   node scripts/fetch-binance-daily.mjs [--through 2026-09] [--out data/binance-daily] [--only BTCUSDT,ETHUSDT]
 *
 * The archive is data.binance.vision. Its S3 endpoint is used because some
 * networks block the website but not S3. Each monthly zip is checked against
 * its published SHA-256 before use. Output: one CSV per pair in the repo's
 * candle format (timestamp,open,high,low,close,volume; timestamp in UNIX
 * seconds), plus manifest.json with rows, first and last date, and the CSV's
 * SHA-256.
 *
 * The archive's timestamps switched from milliseconds to microseconds in 2025.
 * Both are read as seconds here.
 *
 * Behind a proxy, Node's fetch needs NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const BUCKET = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const PREFIX = 'data/spot/monthly/klines/';
const CONCURRENCY = 12;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const through = arg('through', '2026-09');
if (!/^\d{4}-\d{2}$/.test(through)) throw new Error('--through must look like 2026-09');
const outDir = arg('out', 'data/binance-daily');
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, as) {
  for (let attempt = 1; ; attempt++) {
    let status;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      status = response.status;
      if (response.ok) return as === 'bytes' ? Buffer.from(await response.arrayBuffer()) : response.text();
      if (status !== 429 && status < 500) throw new Error(`${url} returned ${status}`);
    } catch (error) {
      if (status !== undefined && status !== 429 && status < 500) throw error;
      status ??= String(error);
    }
    if (attempt >= 6) throw new Error(`${url} failed ${attempt} times; last: ${status}`);
    await sleep(500 * 2 ** attempt);
  }
}

/** Every key or common prefix under `prefix`, following S3's pagination. */
async function list(prefix, delimiter) {
  const keys = [];
  const prefixes = [];
  let marker = '';
  for (;;) {
    const url =
      `${BUCKET}?prefix=${encodeURIComponent(prefix)}` +
      (delimiter ? `&delimiter=${encodeURIComponent(delimiter)}` : '') +
      (marker ? `&marker=${encodeURIComponent(marker)}` : '');
    const xml = await get(url, 'text');
    const pageKeys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => decodeXml(m[1]));
    const pagePrefixes = [...xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)].map(
      (m) => decodeXml(m[1]),
    );
    keys.push(...pageKeys);
    prefixes.push(...pagePrefixes);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    marker = decodeXml(xml.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] ?? (pageKeys.at(-1) ?? pagePrefixes.at(-1)));
  }
  return { keys, prefixes };
}

function decodeXml(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** The single file in a zip, via its central directory. */
function unzipSingle(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const central = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(central) !== 0x02014b50) throw new Error('bad central directory');
  const method = zip.readUInt16LE(central + 10);
  const compressedSize = zip.readUInt32LE(central + 20);
  const localOffset = zip.readUInt32LE(central + 42);
  if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
  const nameLength = zip.readUInt16LE(localOffset + 26);
  const extraLength = zip.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const data = zip.subarray(start, start + compressedSize);
  if (method === 0) return data.toString('utf8');
  if (method === 8) return inflateRawSync(data).toString('utf8');
  throw new Error(`unsupported zip compression method ${method}`);
}

function toSeconds(openTime) {
  // Milliseconds until 2025, microseconds after.
  return openTime > 1e14 ? Math.floor(openTime / 1e6) : Math.floor(openTime / 1e3);
}

async function fetchSymbol(symbol) {
  const { keys } = await list(`${PREFIX}${symbol}/1d/`);
  const zips = keys
    .filter((k) => k.endsWith('.zip'))
    .filter((k) => (k.match(/-(\d{4}-\d{2})\.zip$/)?.[1] ?? '9999-99') <= through);
  const rows = new Map();
  for (const key of zips) {
    const [zip, checksum] = await Promise.all([
      get(`${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`, 'bytes'),
      get(`${BUCKET}/${`${key}.CHECKSUM`.split('/').map(encodeURIComponent).join('/')}`, 'text'),
    ]);
    const expected = checksum.trim().split(/\s+/)[0];
    const actual = createHash('sha256').update(zip).digest('hex');
    if (expected !== actual) throw new Error(`${key}: checksum ${actual} does not match ${expected}`);
    for (const line of unzipSingle(zip).split('\n')) {
      const cells = line.trim().split(',');
      if (cells.length < 6 || !/^\d+$/.test(cells[0])) continue; // blank line or a header
      const t = toSeconds(Number(cells[0]));
      if (t % 86_400 !== 0) throw new Error(`${key}: ${cells[0]} is not a UTC midnight`);
      rows.set(t, [t, cells[1], cells[2], cells[3], cells[4], cells[5]].join(','));
    }
  }
  const times = [...rows.keys()].sort((a, b) => a - b);
  const csv = ['timestamp,open,high,low,close,volume', ...times.map((t) => rows.get(t))].join('\n') + '\n';
  writeFileSync(join(outDir, `${symbol}.csv`), csv);
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  return {
    symbol,
    months: zips.length,
    rows: times.length,
    first: times.length ? iso(times[0]) : null,
    last: times.length ? iso(times.at(-1)) : null,
    sha256: createHash('sha256').update(csv).digest('hex'),
  };
}

const { prefixes } = await list(PREFIX, '/');
const only = arg('only')?.split(',');
const symbols = prefixes
  .map((p) => p.slice(PREFIX.length, -1))
  .filter((s) => s.endsWith('USDT'))
  .filter((s) => !only || only.includes(s));
process.stderr.write(`${symbols.length} USDT pairs in the archive\n`);

const manifest = {};
let done = 0;
const queue = [...symbols];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let symbol = queue.shift(); symbol !== undefined; symbol = queue.shift()) {
      manifest[symbol] = await fetchSymbol(symbol);
      done++;
      if (done % 25 === 0 || done === symbols.length) process.stderr.write(`${done}/${symbols.length}\n`);
    }
  }),
);
const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ through, fetchedAt: new Date().toISOString(), pairs: sorted }, null, 1));
process.stderr.write(`done: ${Object.keys(sorted).length} pairs written to ${outDir}\n`);
