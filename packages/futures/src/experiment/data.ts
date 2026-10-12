import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Bar } from '../types';

/**
 * Read a candle CSV written by scripts/fetch-coinbase-history.mjs:
 * `timestamp,open,high,low,close,volume`, ascending, timestamp in UNIX seconds.
 */
export function loadBars(path: string): Bar[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines[0]?.trim() !== 'timestamp,open,high,low,close,volume') {
    throw new Error(`${path}: unexpected header ${lines[0]}`);
  }
  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const [t, o, h, l, c, v] = line.split(',').map(Number);
    const bar = { t: t!, o: o!, h: h!, l: l!, c: c!, v: v! };
    if (![bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite)) {
      throw new Error(`${path}:${i + 1}: unreadable row "${line}"`);
    }
    const previous = bars.at(-1);
    if (previous && bar.t <= previous.t) throw new Error(`${path}:${i + 1}: not ascending`);
    bars.push(bar);
  }
  return bars;
}

/** First 16 hex digits of the file's SHA-256, as earlier experiments record. */
export function fingerprint(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

export const utcDate = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
export const at = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 1000;
export const pct = (x: number, digits = 2): string => `${(x * 100).toFixed(digits)}%`;
