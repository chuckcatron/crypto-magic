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
   * The oldest snapshot recorded in this mode, or null before the first tick.
   *
   * The dashboard's "since" figure is measured from here. The curve is only the
   * most recent few hundred points, so its first point is not where the account
   * started. Filtered by mode so paper history is never the baseline for live.
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
