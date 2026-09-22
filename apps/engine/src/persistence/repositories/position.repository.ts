import { Inject, Injectable } from '@nestjs/common';
import { D, type Decimal, type Position, type TradingMode } from '@crypto-magic/core';
import { DATABASE } from '../tokens';
import type { Db } from '../database';

export interface StoredPosition extends Position {
  readonly barsHeld: number;
  /** Fee paid on entry, carried so realized P&L on close is net of both legs. */
  readonly entryFee: Decimal;
  readonly protectiveStopOrderId: string | null;
  readonly entryReasons: string[];
  readonly confidence: number;
  readonly mode: TradingMode;
}

interface Row {
  product_id: string;
  base_size: string;
  average_entry_price: string;
  opened_at: number;
  stop_price: string;
  high_water_price: string;
  take_profit_price: string | null;
  entry_atr: string;
  entry_fee: string;
  bars_held: number;
  protective_stop_order_id: string | null;
  entry_reasons: string;
  confidence: number;
  mode: string;
}

@Injectable()
export class PositionRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  findAll(): StoredPosition[] {
    return this.db
      .prepare('SELECT * FROM positions ORDER BY opened_at')
      .all()
      .map((row) => toPosition(row as Row));
  }

  find(productId: string): StoredPosition | null {
    const row = this.db.prepare('SELECT * FROM positions WHERE product_id = ?').get(productId);
    return row ? toPosition(row as Row) : null;
  }

  upsert(position: StoredPosition): void {
    this.db
      .prepare(
        `INSERT INTO positions (
           product_id, base_size, average_entry_price, opened_at, stop_price,
           high_water_price, take_profit_price, entry_atr, entry_fee, bars_held,
           protective_stop_order_id, entry_reasons, confidence, mode
         ) VALUES (
           @productId, @baseSize, @averageEntryPrice, @openedAt, @stopPrice,
           @highWaterPrice, @takeProfitPrice, @entryAtr, @entryFee, @barsHeld,
           @protectiveStopOrderId, @entryReasons, @confidence, @mode
         )
         ON CONFLICT(product_id) DO UPDATE SET
           base_size = excluded.base_size,
           average_entry_price = excluded.average_entry_price,
           stop_price = excluded.stop_price,
           high_water_price = excluded.high_water_price,
           take_profit_price = excluded.take_profit_price,
           entry_atr = excluded.entry_atr,
           entry_fee = excluded.entry_fee,
           bars_held = excluded.bars_held,
           protective_stop_order_id = excluded.protective_stop_order_id`,
      )
      .run({
        productId: position.productId,
        baseSize: position.baseSize.toFixed(),
        averageEntryPrice: position.averageEntryPrice.toFixed(),
        openedAt: position.openedAt,
        stopPrice: position.stopPrice.toFixed(),
        highWaterPrice: position.highWaterPrice.toFixed(),
        takeProfitPrice: position.takeProfitPrice?.toFixed() ?? null,
        entryAtr: position.entryAtr.toFixed(),
        entryFee: position.entryFee.toFixed(),
        barsHeld: position.barsHeld,
        protectiveStopOrderId: position.protectiveStopOrderId,
        entryReasons: JSON.stringify(position.entryReasons),
        confidence: position.confidence,
        mode: position.mode,
      });
  }

  remove(productId: string): void {
    this.db.prepare('DELETE FROM positions WHERE product_id = ?').run(productId);
  }
}

function toPosition(row: Row): StoredPosition {
  return {
    productId: row.product_id,
    baseSize: D(row.base_size),
    averageEntryPrice: D(row.average_entry_price),
    openedAt: row.opened_at,
    stopPrice: D(row.stop_price),
    highWaterPrice: D(row.high_water_price),
    takeProfitPrice: row.take_profit_price ? D(row.take_profit_price) : null,
    entryAtr: D(row.entry_atr),
    entryFee: D(row.entry_fee),
    barsHeld: row.bars_held,
    protectiveStopOrderId: row.protective_stop_order_id,
    entryReasons: safeParseArray(row.entry_reasons),
    confidence: row.confidence,
    mode: row.mode as TradingMode,
  };
}

function safeParseArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
