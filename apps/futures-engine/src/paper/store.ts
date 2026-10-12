import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClosedTrade } from '@crypto-magic/futures';
import Database from 'better-sqlite3';

/**
 * The paper engine's own SQLite file, separate from the regime engine's.
 *
 * Account state and the trades it produced are written in one transaction per
 * batch of bars. After a crash the engine resumes from the last committed
 * state and replays the same bars. That regenerates the same trades, and the
 * unique key turns them into no-ops instead of duplicates.
 */
export class PaperStore {
  private constructor(private readonly db: Database.Database) {}

  static open(path: string): PaperStore {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_state (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_time INTEGER NOT NULL,
        exit_time INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        size REAL NOT NULL,
        gross_pnl REAL NOT NULL,
        fees REAL NOT NULL,
        funding REAL NOT NULL,
        net_pnl REAL NOT NULL,
        return_on_equity REAL NOT NULL,
        exit_reason TEXT NOT NULL,
        reason TEXT NOT NULL,
        UNIQUE (account_id, product_id, entry_time, exit_time)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL
      );
    `);
    return new PaperStore(db);
  }

  close(): void {
    this.db.close();
  }

  /** Run `work` atomically: every write inside lands, or none does. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  loadState<T>(id: string): T | null {
    const row = this.db.prepare('SELECT state FROM account_state WHERE id = ?').get(id) as
      { state: string } | undefined;
    return row ? (JSON.parse(row.state) as T) : null;
  }

  saveState(id: string, state: unknown, at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO account_state (id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify(state), at);
  }

  /** Insert a closed trade; a replay of one already stored is ignored. */
  insertTrade(accountId: string, trade: ClosedTrade): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO trades (account_id, product_id, direction, entry_time, exit_time,
           entry_price, exit_price, size, gross_pnl, fees, funding, net_pnl, return_on_equity,
           exit_reason, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        accountId,
        trade.productId,
        trade.direction,
        trade.entryTime,
        trade.exitTime,
        trade.entryPrice,
        trade.exitPrice,
        trade.size,
        trade.grossPnl,
        trade.fees,
        trade.funding,
        trade.netPnl,
        trade.returnOnEquity,
        trade.exitReason,
        trade.reason,
      );
  }

  addEvent(
    level: 'info' | 'warning' | 'critical',
    kind: string,
    message: string,
    at = Date.now(),
  ): void {
    this.db
      .prepare('INSERT INTO events (at, level, kind, message) VALUES (?, ?, ?, ?)')
      .run(at, level, kind, message);
  }

  recentTrades(limit: number): StoredTrade[] {
    return this.db
      .prepare('SELECT * FROM trades ORDER BY exit_time DESC, id DESC LIMIT ?')
      .all(limit) as StoredTrade[];
  }

  recentEvents(limit: number): StoredEvent[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as StoredEvent[];
  }

  /** Closed trades, winners and net P&L, per sub-account that has any. */
  tradeStats(): Record<string, TradeStats> {
    const rows = this.db
      .prepare(
        `SELECT account_id, COUNT(*) AS trades, SUM(net_pnl > 0) AS wins, SUM(net_pnl) AS net_pnl
         FROM trades GROUP BY account_id`,
      )
      .all() as { account_id: string; trades: number; wins: number; net_pnl: number }[];
    return Object.fromEntries(
      rows.map((r) => [r.account_id, { trades: r.trades, wins: r.wins, netPnl: r.net_pnl }]),
    );
  }
}

export interface TradeStats {
  readonly trades: number;
  readonly wins: number;
  /** Sum of the closed trades' net P&L, after fees and funding. */
  readonly netPnl: number;
}

export interface StoredTrade {
  readonly id: number;
  readonly account_id: string;
  readonly product_id: string;
  readonly direction: string;
  readonly entry_time: number;
  readonly exit_time: number;
  readonly entry_price: number;
  readonly exit_price: number;
  readonly size: number;
  readonly gross_pnl: number;
  readonly fees: number;
  readonly funding: number;
  readonly net_pnl: number;
  readonly return_on_equity: number;
  readonly exit_reason: string;
  readonly reason: string;
}

export interface StoredEvent {
  readonly id: number;
  readonly at: number;
  readonly level: string;
  readonly kind: string;
  readonly message: string;
}
