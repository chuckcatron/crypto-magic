import { Inject, Injectable } from '@nestjs/common';
import { D, type Decimal, type TradingMode } from '@crypto-magic/core';
import { DATABASE } from '../tokens';
import type { Db } from '../database';
import type { StateStore } from '../ports';

export interface EquitySnapshot {
  ts: number;
  equity: Decimal;
  cash: Decimal;
  positionValue: Decimal;
  mode: TradingMode;
}

/** Small key/value store for engine flags, plus the equity time series. */
@Injectable()
export class StateRepository implements StateStore {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM engine_state WHERE key = ?').get(key);
    return row ? (row as { value: string }).value : null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  recordEquity(snapshot: EquitySnapshot): void {
    this.db
      .prepare(
        `INSERT INTO equity_snapshots (ts, equity, cash, position_value, mode)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ts) DO UPDATE SET
           equity = excluded.equity, cash = excluded.cash, position_value = excluded.position_value`,
      )
      .run(
        snapshot.ts,
        snapshot.equity.toFixed(),
        snapshot.cash.toFixed(),
        snapshot.positionValue.toFixed(),
        snapshot.mode,
      );
  }

  equityCurve(limit = 1000): EquitySnapshot[] {
    return this.db
      .prepare('SELECT * FROM equity_snapshots ORDER BY ts DESC LIMIT ?')
      .all(limit)
      .map((row) => toSnapshot(row as EquityRow))
      .reverse();
  }

  /**
   * The whole run in this mode, thinned to at most `maxPoints` for the chart.
   *
   * The engine records a snapshot every tick, about 2,900 a day, so the full
   * series soon runs to tens of thousands of rows. This cuts the run into
   * `maxPoints` equal stretches of time and keeps the last snapshot in each:
   * the curve still ends on the current value, and a stretch with no snapshots
   * (the engine stopped, the Mac asleep) stays empty, so it still reads as a gap.
   *
   * One indexed lookup per stretch, not a scan: better-sqlite3 is synchronous,
   * the dashboard asks every few seconds, and a GROUP BY over a year of
   * snapshots held the engine's loop for most of a second.
   */
  equityHistory(mode: TradingMode, maxPoints: number): EquitySnapshot[] {
    const first = this.firstEquity(mode);
    const last = this.db
      .prepare('SELECT * FROM equity_snapshots WHERE mode = ? ORDER BY ts DESC LIMIT 1')
      .get(mode) as EquityRow | undefined;
    if (!first || !last) return [];

    const bucketMs = Math.max(1, Math.ceil((last.ts - first.ts + 1) / maxPoints));
    const newestIn = this.db.prepare(
      `SELECT * FROM equity_snapshots
       WHERE ts >= ? AND ts < ? AND mode = ?
       ORDER BY ts DESC LIMIT 1`,
    );
    const history: EquitySnapshot[] = [];
    for (let from = first.ts; from <= last.ts; from += bucketMs) {
      const row = newestIn.get(from, from + bucketMs, mode) as EquityRow | undefined;
      if (row) history.push(toSnapshot(row));
    }
    return history;
  }

  /**
   * The oldest snapshot recorded in this mode, or null before the first tick.
   *
   * The dashboard's "since" figure is measured from here. Filtered by mode so
   * paper history is never the baseline for live.
   */
  firstEquity(mode: TradingMode): EquitySnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM equity_snapshots WHERE mode = ? ORDER BY ts ASC LIMIT 1')
      .get(mode);
    return row ? toSnapshot(row as EquityRow) : null;
  }
}

interface EquityRow {
  ts: number;
  equity: string;
  cash: string;
  position_value: string;
  mode: string;
}

function toSnapshot(r: EquityRow): EquitySnapshot {
  return {
    ts: r.ts,
    equity: D(r.equity),
    cash: D(r.cash),
    positionValue: D(r.position_value),
    mode: r.mode as TradingMode,
  };
}
