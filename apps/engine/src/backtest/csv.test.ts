import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCsv, parseTime } from './csv';

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
