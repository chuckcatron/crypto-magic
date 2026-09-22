import { readFileSync } from 'node:fs';
import type { Candle, Granularity } from '@crypto-magic/core';

/**
 * Load candles from a CSV instead of the exchange.
 *
 * Coinbase's candle endpoint is fine for a year or two, but a trend follower
 * needs to be seen across a full cycle — a bull run AND a bear market — and
 * that history is easier to get as a file. Column names are matched loosely
 * because every data source spells them differently.
 */
export function loadCsv(path: string, productId: string, granularity: Granularity): Candle[] {
  const text = readFileSync(path, 'utf8').trim();
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`${path} has no data rows`);

  const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const find = (...names: string[]) => {
    for (const name of names) {
      const index = header.indexOf(name);
      if (index !== -1) return index;
    }
    return -1;
  };

  const cols = {
    time: find('unix_timestamp', 'timestamp', 'time', 'date', 'datetime', 'open_time'),
    open: find('open', 'o'),
    high: find('high', 'h'),
    low: find('low', 'l'),
    close: find('close', 'c'),
    volume: find('volume', 'v', 'volume_btc', 'volumefrom'),
  };
  for (const [name, index] of Object.entries(cols)) {
    if (index === -1 && name !== 'volume') {
      throw new Error(`${path} is missing a "${name}" column. Found: ${header.join(', ')}`);
    }
  }

  const candles: Candle[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const openTime = parseTime(cells[cols.time]);
    const open = Number.parseFloat(cells[cols.open] ?? '');
    const high = Number.parseFloat(cells[cols.high] ?? '');
    const low = Number.parseFloat(cells[cols.low] ?? '');
    const close = Number.parseFloat(cells[cols.close] ?? '');

    // Skip malformed rows rather than poisoning the run with NaN.
    if (![openTime, open, high, low, close].every(Number.isFinite)) continue;
    if (close <= 0 || high < low) continue;

    candles.push({
      productId,
      granularity,
      openTime,
      open,
      high,
      low,
      close,
      volume: Number.parseFloat(cells[cols.volume] ?? '0') || 0,
    });
  }

  // De-duplicate and sort; the backtester requires strictly ascending bars.
  const byTime = new Map(candles.map((c) => [c.openTime, c]));
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Accepts unix seconds, unix millis, or anything Date can parse. */
export function parseTime(raw: string | undefined): number {
  if (!raw) return Number.NaN;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Number.NaN;
}

