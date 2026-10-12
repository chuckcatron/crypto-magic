import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D, type TradingMode } from '@crypto-magic/core';
import { openDatabase, type Db } from '../database';
import { StateRepository } from './state.repository';

const TICK_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const START = Date.UTC(2026, 8, 29);

describe('StateRepository.equityHistory', () => {
  let db: Db;
  let state: StateRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    state = new StateRepository(db);
  });
  afterEach(() => db.close());

  /** One snapshot per tick from `from` up to, not including, `to`. Equity is the tick's index. */
  function record(from: number, to: number, mode: TradingMode = 'paper'): void {
    db.transaction(() => {
      for (let ts = from; ts < to; ts += TICK_MS) {
        const equity = D((ts - START) / TICK_MS);
        state.recordEquity({ ts, equity, cash: equity, positionValue: D(0), mode });
      }
    })();
  }

  it('is empty before the first tick', () => {
    expect(state.equityHistory('paper', 500)).toEqual([]);
  });

  it('returns every snapshot when the run is short', () => {
    record(START, START + 100 * TICK_MS);

    const history = state.equityHistory('paper', 500);

    expect(history).toHaveLength(100);
    expect(history[0]!.ts).toBe(START);
    expect(history.at(-1)!.ts).toBe(START + 99 * TICK_MS);
  });

  it('thins two weeks of ticks to the limit, ending on the newest snapshot', () => {
    const end = START + 14 * DAY_MS;
    record(START, end);

    const history = state.equityHistory('paper', 500);

    expect(history.length).toBeGreaterThan(450);
    expect(history.length).toBeLessThanOrEqual(500);
    const ts = history.map((s) => s.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts[0]! - START).toBeLessThan(DAY_MS / 30);
    expect(ts.at(-1)).toBe(end - TICK_MS);
    // Each point is a real snapshot, not an average.
    const newest = history.at(-1)!;
    expect(newest.equity.toFixed()).toBe(String((end - TICK_MS - START) / TICK_MS));
  });

  it('keeps a night with no snapshots as a gap', () => {
    record(START, START + 3 * DAY_MS);
    record(START + 3 * DAY_MS + 10 * HOUR_MS, START + 7 * DAY_MS);

    const ts = state.equityHistory('paper', 500).map((s) => s.ts);

    // An empty stretch adds nothing: no repeat of the snapshot before it.
    expect(new Set(ts).size).toBe(ts.length);
    const steps = ts.slice(1).map((t, i) => t - ts[i]!);
    const typical = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]!;
    const longest = Math.max(...steps);
    expect(longest).toBeGreaterThan(9 * HOUR_MS);
    // The dashboard calls a step a gap at five typical steps.
    expect(longest).toBeGreaterThan(5 * typical);
  });

  it('covers only the requested mode', () => {
    record(START - 30 * DAY_MS, START - 20 * DAY_MS, 'live');
    record(START, START + 2 * DAY_MS, 'paper');

    const history = state.equityHistory('paper', 500);

    expect(history.every((s) => s.mode === 'paper')).toBe(true);
    expect(history[0]!.ts - START).toBeLessThan(DAY_MS / 100);
  });
});
