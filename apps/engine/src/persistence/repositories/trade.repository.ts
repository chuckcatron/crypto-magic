import { Inject, Injectable } from '@nestjs/common';
import { D, type Decimal, type ExitReason, type TradingMode } from '@crypto-magic/core';
import { DATABASE } from '../tokens';
import type { Db } from '../database';
import type { TradeStore } from '../ports';

export interface StoredTrade {
  id?: number;
  productId: string;
  entryTime: number;
  exitTime: number;
  entryPrice: Decimal;
  exitPrice: Decimal;
  baseSize: Decimal;
  fees: Decimal;
  pnl: Decimal;
  pnlPct: number;
  exitReason: ExitReason;
  entryReasons: string[];
  confidence: number;
  mode: TradingMode;
  /** The risk the bot actually took, so a post-mortem can judge it. */
  stopPrice: Decimal | null;
  takeProfitPrice: Decimal | null;
}

@Injectable()
export class TradeRepository implements TradeStore {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  insert(trade: StoredTrade): void {
    this.db
      .prepare(
        `INSERT INTO trades (
           product_id, entry_time, exit_time, entry_price, exit_price, base_size,
           fees, pnl, pnl_pct, exit_reason, entry_reasons, confidence, mode,
           stop_price, take_profit_price
         ) VALUES (
           @productId, @entryTime, @exitTime, @entryPrice, @exitPrice, @baseSize,
           @fees, @pnl, @pnlPct, @exitReason, @entryReasons, @confidence, @mode,
           @stopPrice, @takeProfitPrice
         )`,
      )
      .run({
        ...trade,
        entryPrice: trade.entryPrice.toFixed(),
        exitPrice: trade.exitPrice.toFixed(),
        baseSize: trade.baseSize.toFixed(),
        fees: trade.fees.toFixed(),
        pnl: trade.pnl.toFixed(),
        entryReasons: JSON.stringify(trade.entryReasons),
        stopPrice: trade.stopPrice?.toFixed() ?? null,
        takeProfitPrice: trade.takeProfitPrice?.toFixed() ?? null,
      });
  }

  /** Realized P&L since a timestamp. Drives the daily loss circuit breaker. */
  realizedPnlSince(sinceMs: number): Decimal {
    const rows = this.db
      .prepare('SELECT pnl FROM trades WHERE exit_time >= ?')
      .all(sinceMs) as { pnl: string }[];
    return rows.reduce((sum, row) => sum.plus(D(row.pnl)), D(0));
  }

  /**
   * Losing trades at the end of the trade history. A winner anywhere in the run
   * resets the count, which is the point: the breaker is for a losing streak,
   * not a losing total.
   */
  consecutiveLosses(): number {
    const rows = this.db
      .prepare('SELECT pnl FROM trades ORDER BY exit_time DESC, id DESC LIMIT 50')
      .all() as { pnl: string }[];
    let count = 0;
    for (const row of rows) {
      if (D(row.pnl).gt(0)) break;
      count++;
    }
    return count;
  }

  findById(id: number): StoredTrade | null {
    const row = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
    return row ? toTrade(row as never) : null;
  }

  recent(limit = 100): StoredTrade[] {
    return this.db
      .prepare('SELECT * FROM trades ORDER BY exit_time DESC LIMIT ?')
      .all(limit)
      .map((row) => toTrade(row as never));
  }

  all(): StoredTrade[] {
    return this.db
      .prepare('SELECT * FROM trades ORDER BY exit_time')
      .all()
      .map((row) => toTrade(row as never));
  }
}

function toTrade(row: Record<string, string | number | null>): StoredTrade {
  return {
    id: Number(row.id),
    productId: String(row.product_id),
    entryTime: Number(row.entry_time),
    exitTime: Number(row.exit_time),
    entryPrice: D(String(row.entry_price)),
    exitPrice: D(String(row.exit_price)),
    baseSize: D(String(row.base_size)),
    fees: D(String(row.fees)),
    pnl: D(String(row.pnl)),
    pnlPct: Number(row.pnl_pct),
    exitReason: String(row.exit_reason) as ExitReason,
    entryReasons: parseArray(String(row.entry_reasons)),
    confidence: Number(row.confidence),
    mode: String(row.mode) as TradingMode,
    stopPrice: row.stop_price == null ? null : D(String(row.stop_price)),
    takeProfitPrice: row.take_profit_price == null ? null : D(String(row.take_profit_price)),
  };
}

function parseArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
