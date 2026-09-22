import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCsv, parseCsvLine, parseNumber, parseTime } from './csv';

const dir = mkdtempSync(join(tmpdir(), 'cm-csv-'));
let n = 0;
const write = (content: string): string => {
  const path = join(dir, `t${n++}.csv`);
  writeFileSync(path, content);
  return path;
};

const load = (content: string) => loadCsv(write(content), 'BTC-USD', 'ONE_HOUR');

describe('parseTime', () => {
  it('accepts unix seconds', () => {
    expect(parseTime('1672531200')).toBe(1_672_531_200);
  });

  it('accepts unix milliseconds and narrows to seconds', () => {
    expect(parseTime('1672531200000')).toBe(1_672_531_200);
  });

  it('accepts an ISO date', () => {
    expect(parseTime('2023-01-01T00:00:00Z')).toBe(1_672_531_200);
  });

  it('returns NaN for junk rather than a bogus date', () => {
    expect(Number.isNaN(parseTime('not a date'))).toBe(true);
    expect(Number.isNaN(parseTime(undefined))).toBe(true);
  });
});

describe('loadCsv', () => {
  const header = 'timestamp,open,high,low,close,volume';

  it('parses a well-formed file', () => {
    const candles = load(`${header}\n1672531200,100,110,90,105,12\n1672534800,105,115,95,108,9`);
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({
      productId: 'BTC-USD',
      granularity: 'ONE_HOUR',
      openTime: 1_672_531_200,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 12,
    });
  });

  it('matches column names case-insensitively and by common alias', () => {
    const candles = load('DATETIME,O,H,L,C,V\n2023-01-01T00:00:00Z,100,110,90,105,3');
    expect(candles).toHaveLength(1);
    expect(candles[0]!.close).toBe(105);
  });

  it('accepts the UNIX_TIMESTAMP spelling some datasets use', () => {
    expect(load(`UNIX_TIMESTAMP,OPEN,HIGH,LOW,CLOSE\n1672531200,1,2,0.5,1.5`)).toHaveLength(1);
  });

  it('tolerates quoted cells', () => {
    const candles = load(`"timestamp","open","high","low","close"\n"1672531200","100","110","90","105"`);
    expect(candles[0]!.open).toBe(100);
  });

  it('defaults volume to zero when the column is absent', () => {
    const candles = load('timestamp,open,high,low,close\n1672531200,100,110,90,105');
    expect(candles[0]!.volume).toBe(0);
  });

  it('sorts out-of-order rows, because the backtester requires ascending bars', () => {
    const candles = load(
      `${header}\n1672534800,105,115,95,108,9\n1672531200,100,110,90,105,12`,
    );
    expect(candles.map((c) => c.openTime)).toEqual([1_672_531_200, 1_672_534_800]);
  });

  it('de-duplicates repeated timestamps', () => {
    const candles = load(
      `${header}\n1672531200,100,110,90,105,12\n1672531200,100,110,90,107,12`,
    );
    expect(candles).toHaveLength(1);
  });

  it.each([
    ['a NaN price', '1672531200,100,110,90,abc,1'],
    ['a missing field', '1672531200,100,110'],
    ['a zero close', '1672531200,100,110,90,0,1'],
    ['high below low', '1672531200,100,50,90,95,1'],
    ['an unparseable timestamp', 'yesterday,100,110,90,105,1'],
  ])('skips %s rather than poisoning the run', (_label, row) => {
    const candles = load(`${header}\n${row}\n1672534800,105,115,95,108,9`);
    expect(candles).toHaveLength(1);
    expect(candles[0]!.openTime).toBe(1_672_534_800);
  });

  it('ignores blank lines', () => {
    const candles = load(`${header}\n\n1672531200,100,110,90,105,12\n\n`);
    expect(candles).toHaveLength(1);
  });

  it('names the missing column when a required one is absent', () => {
    expect(() => load('timestamp,open,high,low\n1,2,3,4')).toThrow(/missing a "close" column/);
  });

  it('rejects a file with no data rows', () => {
    expect(() => load(header)).toThrow(/no data rows/);
  });
});

describe('parseCsvLine', () => {
  it('keeps commas inside quoted fields', () => {
    expect(parseCsvLine('"Aug 02, 2020","11,105.8","x"')).toEqual(['Aug 02, 2020', '11,105.8', 'x']);
  });

  it('treats a doubled quote as a literal quote', () => {
    expect(parseCsvLine('"say ""hi""",2')).toEqual(['say "hi"', '2']);
  });

  it('handles unquoted and empty fields', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseNumber', () => {
  it('strips thousands separators', () => expect(parseNumber('11,105.8')).toBe(11105.8));
  it('expands K/M/B volume suffixes', () => {
    expect(parseNumber('698.62K')).toBeCloseTo(698_620, 6);
    expect(parseNumber('1.5M')).toBe(1_500_000);
    expect(parseNumber('2B')).toBe(2e9);
  });
  it('rejects junk rather than guessing', () => {
    expect(Number.isNaN(parseNumber('-'))).toBe(true);
    expect(Number.isNaN(parseNumber('abc'))).toBe(true);
    expect(Number.isNaN(parseNumber(undefined))).toBe(true);
  });
});

describe('loadCsv — investing.com export', () => {
  // The most common free BTC history format, verbatim: BOM, every field quoted,
  // commas inside prices and dates, "Price" meaning close, newest row first.
  const investing = [
    '\uFEFF"Date","Price","Open","High","Low","Vol.","Change %"',
    '"Aug 02, 2020","11,105.8","11,802.6","12,061.1","10,730.7","698.62K","-5.91%"',
    '"Aug 01, 2020","11,803.1","11,333.2","11,847.7","11,226.1","611.47K","4.14%"',
  ].join('\n');

  it('parses every row with correct values', () => {
    const candles = load(investing);
    expect(candles).toHaveLength(2);
    expect(candles[1]).toMatchObject({
      open: 11802.6,
      high: 12061.1,
      low: 10730.7,
      close: 11105.8,
    });
    expect(candles[1]!.volume).toBeCloseTo(698_620, 6);
  });

  it('reads "Price" as the close', () => {
    expect(load(investing)[0]!.close).toBe(11803.1);
  });

  it('parses bare dates as UTC midnight, the same on every machine', () => {
    expect(load(investing)[0]!.openTime).toBe(Date.UTC(2020, 7, 1) / 1000);
  });

  it('sorts newest-first exports into ascending order', () => {
    const [first, second] = load(investing);
    expect(first!.openTime).toBeLessThan(second!.openTime);
  });
});
