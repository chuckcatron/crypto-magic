import { readFileSync } from 'node:fs';
import type { Candle, Granularity } from '@crypto-magic/core';

/**
 * Split one CSV line into cells, honouring double-quoted fields.
 *
 * The first version split on every comma, which works for machine exports and
 * breaks on the most common free source of BTC history: investing.com quotes
 * every field and uses commas inside them — "11,105.8" as a price and
 * "Aug 02, 2020" as a date. A doubled quote inside a quoted field is a literal
 * quote, per RFC 4180.
 */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * A number as data sources actually write them: thousands separators, and
 * volume with a K/M/B suffix. Returns NaN for anything else.
 */
export function parseNumber(raw: string | undefined): number {
  if (raw === undefined) return Number.NaN;
  const cleaned = raw.trim().replace(/,/g, '');
  const match = /^(-?\d*\.?\d+)([KMB])?$/i.exec(cleaned);
  if (!match) return Number.NaN;
  const value = Number.parseFloat(match[1]!);
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[(match[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'];
  return multiplier ? value * multiplier : value;
}

/**
 * Load candles from a CSV instead of the exchange.
 *
 * Coinbase's candle endpoint is fine for a year or two, but a trend follower
 * needs to be seen across a full cycle — a bull run AND a bear market — and
 * that history is easier to get as a file. Column names are matched loosely
 * because every data source spells them differently.
 */
export function loadCsv(path: string, productId: string, granularity: Granularity): Candle[] {
  // Strip a UTF-8 byte-order mark, which Excel and investing.com both prepend
  // and which would otherwise glue itself to the first column name.
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim();
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`${path} has no data rows`);

  const header = parseCsvLine(lines[0]!).map((h) => h.toLowerCase());
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
    close: find('close', 'c', 'price', 'adj close'),
    volume: find('volume', 'v', 'vol.', 'vol', 'volume_btc', 'volumefrom'),
  };
  for (const [name, index] of Object.entries(cols)) {
    if (index === -1 && name !== 'volume') {
      throw new Error(`${path} is missing a "${name}" column. Found: ${header.join(', ')}`);
    }
  }

  const candles: Candle[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const openTime = parseTime(cells[cols.time]);
    const open = parseNumber(cells[cols.open]);
    const high = parseNumber(cells[cols.high]);
    const low = parseNumber(cells[cols.low]);
    const close = parseNumber(cells[cols.close]);

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
      volume: parseNumber(cells[cols.volume]) || 0,
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
  // A bare date like "Aug 02, 2020" would otherwise parse in the machine's local
  // zone, so the same file would produce different bar times on different Macs.
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$|\bUTC\b|\bGMT\b/.test(raw);
  const parsed = Date.parse(hasZone ? raw : `${raw} UTC`);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  const fallback = Date.parse(raw);
  return Number.isFinite(fallback) ? Math.floor(fallback / 1000) : Number.NaN;
}

