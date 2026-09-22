/**
 * Schema migrations, applied in order and recorded so each runs exactly once.
 *
 * Every monetary value is stored as TEXT. SQLite REAL is a float, and a float is
 * the wrong type for money: a position size that survives a restart must be the
 * size we actually hold, to the last satoshi.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001-initial',
    sql: `
      CREATE TABLE positions (
        product_id               TEXT PRIMARY KEY,
        base_size                TEXT NOT NULL,
        average_entry_price      TEXT NOT NULL,
        opened_at                INTEGER NOT NULL,
        stop_price               TEXT NOT NULL,
        high_water_price         TEXT NOT NULL,
        take_profit_price        TEXT,
        entry_atr                TEXT NOT NULL,
        entry_fee                TEXT NOT NULL DEFAULT '0',
        bars_held                INTEGER NOT NULL DEFAULT 0,
        protective_stop_order_id TEXT,
        entry_reasons            TEXT NOT NULL DEFAULT '[]',
        confidence               REAL NOT NULL DEFAULT 0,
        mode                     TEXT NOT NULL
      );

      CREATE TABLE orders (
        order_id            TEXT PRIMARY KEY,
        client_order_id     TEXT NOT NULL UNIQUE,
        product_id          TEXT NOT NULL,
        side                TEXT NOT NULL,
        status              TEXT NOT NULL,
        requested_base_size TEXT NOT NULL,
        filled_size         TEXT NOT NULL DEFAULT '0',
        average_fill_price  TEXT NOT NULL DEFAULT '0',
        fee                 TEXT NOT NULL DEFAULT '0',
        reference_price     TEXT NOT NULL,
        reason              TEXT,
        exit_reason         TEXT,
        mode                TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE INDEX idx_orders_created_at ON orders (created_at);
      CREATE INDEX idx_orders_product ON orders (product_id, created_at);

      CREATE TABLE trades (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id    TEXT NOT NULL,
        entry_time    INTEGER NOT NULL,
        exit_time     INTEGER NOT NULL,
        entry_price   TEXT NOT NULL,
        exit_price    TEXT NOT NULL,
        base_size     TEXT NOT NULL,
        fees          TEXT NOT NULL,
        pnl           TEXT NOT NULL,
        pnl_pct       REAL NOT NULL,
        exit_reason   TEXT NOT NULL,
        entry_reasons TEXT NOT NULL DEFAULT '[]',
        confidence    REAL NOT NULL DEFAULT 0,
        mode          TEXT NOT NULL
      );
      CREATE INDEX idx_trades_exit_time ON trades (exit_time);

      CREATE TABLE equity_snapshots (
        ts             INTEGER PRIMARY KEY,
        equity         TEXT NOT NULL,
        cash           TEXT NOT NULL,
        position_value TEXT NOT NULL,
        mode           TEXT NOT NULL
      );

      CREATE TABLE events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        level   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        message TEXT NOT NULL,
        data    TEXT
      );
      CREATE INDEX idx_events_ts ON events (ts);

      CREATE TABLE engine_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: '002-trade-analyses',
    sql: `
      -- Stop and target are recorded on the closed trade so a post-mortem can
      -- see the risk the bot actually took, not just the outcome.
      ALTER TABLE trades ADD COLUMN stop_price TEXT;
      ALTER TABLE trades ADD COLUMN take_profit_price TEXT;

      CREATE TABLE trade_analyses (
        trade_id    INTEGER PRIMARY KEY REFERENCES trades(id) ON DELETE CASCADE,
        created_at  INTEGER NOT NULL,
        model       TEXT NOT NULL,
        verdict     TEXT NOT NULL,
        summary     TEXT NOT NULL,
        what_worked TEXT NOT NULL DEFAULT '[]',
        what_didnt  TEXT NOT NULL DEFAULT '[]',
        lesson      TEXT,
        used_news   INTEGER NOT NULL DEFAULT 0,
        news_count  INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );

      -- Trades the worker tried and failed to analyse, so a model that cannot
      -- produce usable JSON does not get retried forever on the same row.
      CREATE TABLE trade_analysis_failures (
        trade_id   INTEGER PRIMARY KEY REFERENCES trades(id) ON DELETE CASCADE,
        attempts   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_tried INTEGER NOT NULL
      );
    `,
  },
];
