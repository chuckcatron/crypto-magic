/**
 * EXPERIMENT-008's data checks, run before any strategy:
 *   (a) missing 5-minute bars per coin per year;
 *   (b) 5-minute bars against Coinbase's own daily candles (closes within 0.05%);
 *   (c) perpetual candles against spot, where the public API serves them.
 *
 *   pnpm --filter @crypto-magic/futures validate-008 [--data ../../data]
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DAY, FIVE_MINUTES, type Bar } from '../types';
import { fingerprint, loadBars, pct, utcDate } from './data';

const dataDir = resolve(argument('data') ?? join(__dirname, '../../../../data'));
const COINS = [
  { spot: 'BTC-USD', file: 'btc-5m.csv', perp: 'BIP-20DEC30-CDE' },
  { spot: 'ETH-USD', file: 'eth-5m.csv', perp: 'ETP-20DEC30-CDE' },
  { spot: 'SOL-USD', file: 'sol-5m.csv', perp: 'SLP-20DEC30-CDE' },
];

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

console.log(`# EXPERIMENT-008 data checks — ${new Date().toISOString()}\n`);
console.log('## Files\n');
console.log('| File | Bars | First | Last | SHA-256 (first 16) |');
console.log('| ---- | ---- | ----- | ---- | ------------------ |');
const spot = new Map<string, Bar[]>();
for (const coin of COINS) {
  const path = join(dataDir, coin.file);
  const bars = loadBars(path);
  spot.set(coin.spot, bars);
  console.log(
    `| \`${coin.file}\` | ${bars.length} | ${utcDate(bars[0]!.t)} | ${utcDate(bars.at(-1)!.t)} | \`${fingerprint(path)}\` |`,
  );
}

console.log('\n## (a) Missing 5-minute bars by year\n');
const years = new Set<number>();
const missingBy = new Map<string, Map<number, number>>();
for (const coin of COINS) {
  const bars = spot.get(coin.spot)!;
  const byYear = new Map<number, number>();
  for (let i = 1; i < bars.length; i++) {
    const gap = (bars[i]!.t - bars[i - 1]!.t) / FIVE_MINUTES - 1;
    if (gap <= 0) continue;
    const year = new Date(bars[i - 1]!.t * 1000).getUTCFullYear();
    byYear.set(year, (byYear.get(year) ?? 0) + gap);
    years.add(year);
  }
  for (const year of [...new Set(bars.map((b) => new Date(b.t * 1000).getUTCFullYear()))])
    years.add(year);
  missingBy.set(coin.spot, byYear);
}
const sortedYears = [...years].sort();
console.log(`| Coin | ${sortedYears.join(' | ')} |`);
console.log(`| ---- | ${sortedYears.map(() => '---').join(' | ')} |`);
for (const coin of COINS) {
  const byYear = missingBy.get(coin.spot)!;
  console.log(`| ${coin.spot} | ${sortedYears.map((y) => byYear.get(y) ?? 0).join(' | ')} |`);
}
console.log('\nOne year of 5-minute bars is 105,120 (105,408 in a leap year).');

console.log("\n## (b) 5-minute bars against Coinbase's daily candles\n");
console.log('| Coin | Days compared | Close off by > 0.05% | Share | Largest gap | Verdict |');
console.log('| ---- | ------------- | -------------------- | ----- | ----------- | ------- |');
for (const coin of COINS) {
  const dailyPath = join(dataDir, 'daily', `${coin.spot}.csv`);
  const daily = new Map(loadBars(dailyPath).map((b) => [b.t, b]));
  const lastClose = new Map<number, number>();
  for (const bar of spot.get(coin.spot)!) lastClose.set(Math.floor(bar.t / DAY) * DAY, bar.c);
  let compared = 0;
  let off = 0;
  let worst = { diff: 0, day: 0 };
  for (const [day, close] of lastClose) {
    const candle = daily.get(day);
    if (!candle) continue;
    compared++;
    const diff = Math.abs(close / candle.c - 1);
    if (diff > 0.0005) off++;
    if (diff > worst.diff) worst = { diff, day };
  }
  const share = off / compared;
  console.log(
    `| ${coin.spot} | ${compared} | ${off} | ${pct(share)} | ${worst.diff > 0 ? `${pct(worst.diff, 3)} on ${utcDate(worst.day)}` : 'none'} | ${share > 0.01 ? '**investigate**' : 'ok'} |`,
  );
}

console.log('\n## (c) Perpetual against spot, 5-minute closes\n');
console.log(
  '| Perpetual | Bars matched | Basis median | Basis 5th–95th pct | Bars beyond ±0.1% | Return correlation |',
);
console.log(
  '| --------- | ------------ | ------------ | ------------------ | ----------------- | ------------------ |',
);
for (const coin of COINS) {
  const path = join(dataDir, 'perp-5m', `${coin.perp}.csv`);
  if (!existsSync(path)) {
    console.log(`| ${coin.perp} | not served | | | | |`);
    continue;
  }
  const perp = loadBars(path);
  const spotByTime = new Map(spot.get(coin.spot)!.map((b) => [b.t, b.c]));
  const basis: number[] = [];
  const pairs: [number, number][] = [];
  let previous: { p: number; s: number; t: number } | null = null;
  for (const bar of perp) {
    const s = spotByTime.get(bar.t);
    if (s === undefined) continue;
    basis.push(bar.c / s - 1);
    if (previous && bar.t - previous.t === FIVE_MINUTES) {
      pairs.push([Math.log(bar.c / previous.p), Math.log(s / previous.s)]);
    }
    previous = { p: bar.c, s, t: bar.t };
  }
  basis.sort((a, b) => a - b);
  const q = (f: number) => basis[Math.floor(f * (basis.length - 1))]!;
  const beyond = basis.filter((b) => Math.abs(b) > 0.001).length / basis.length;
  console.log(
    `| ${coin.perp} | ${basis.length} | ${pct(q(0.5), 3)} | ${pct(q(0.05), 3)} to ${pct(q(0.95), 3)} | ${pct(beyond)} | ${correlation(pairs).toFixed(3)} |`,
  );
}

function correlation(pairs: readonly [number, number][]): number {
  const n = pairs.length;
  const mx = pairs.reduce((a, [x]) => a + x, 0) / n;
  const my = pairs.reduce((a, [, y]) => a + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}
