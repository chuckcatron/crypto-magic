/**
 * EXPERIMENT-009 data inventory, descriptive only: what each universe holds,
 * how many of its coins stopped trading, and where a coin's history has a gap
 * (a delisting and relisting under the same ticker shows up here).
 *
 *   pnpm --filter @crypto-magic/futures inventory-009
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BINANCE_EXCLUDED, COINBASE_EXCLUDED } from '../portfolio/universes';
import { DAY } from '../types';
import { loadBars, utcDate } from './data';

const dataDir = resolve(process.argv[2] ?? join(__dirname, '../../../../data'));
const LAST = Date.UTC(2026, 8, 30) / 1000;

for (const [label, dir, keep] of [
  [
    'B (Binance USDT)',
    'binance-daily',
    (s: string) => s.endsWith('USDT') && !BINANCE_EXCLUDED.has(s),
  ],
  [
    'C (Coinbase USD)',
    'coinbase-daily',
    (s: string) => s.endsWith('-USD') && !COINBASE_EXCLUDED.has(s),
  ],
] as const) {
  const files = readdirSync(join(dataDir, dir)).filter(
    (f) => f.endsWith('.csv') && keep(f.slice(0, -4)),
  );
  let empty = 0;
  let stopped = 0;
  const firstYears = new Map<number, number>();
  const gaps: string[] = [];
  for (const file of files) {
    const path = join(dataDir, dir, file);
    if (statSync(path).size === 0) {
      empty++;
      continue;
    }
    const bars = loadBars(path);
    if (bars.length === 0) {
      empty++;
      continue;
    }
    const year = new Date(bars[0]!.t * 1000).getUTCFullYear();
    firstYears.set(year, (firstYears.get(year) ?? 0) + 1);
    if (bars.at(-1)!.t < LAST) stopped++;
    for (let i = 1; i < bars.length; i++) {
      const days = (bars[i]!.t - bars[i - 1]!.t) / DAY;
      if (days > 7) {
        const jump = bars[i]!.o / bars[i - 1]!.c;
        gaps.push(
          `${file.slice(0, -4)} ${utcDate(bars[i - 1]!.t)} → ${utcDate(bars[i]!.t)} (${days} days, price ×${jump.toPrecision(3)})`,
        );
      }
    }
  }
  console.log(`## ${label}`);
  console.log(
    `files kept: ${files.length}, empty: ${empty}, stopped trading before 2026-09-30: ${stopped}`,
  );
  console.log(
    `first year of history: ${[...firstYears.entries()]
      .sort(([a], [b]) => a - b)
      .map(([y, n]) => `${y}: ${n}`)
      .join(', ')}`,
  );
  console.log(`gaps over 7 days: ${gaps.length}`);
  for (const gap of gaps.slice(0, 40)) console.log(`  ${gap}`);
  console.log('');
}
