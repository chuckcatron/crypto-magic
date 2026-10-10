import { Inject, Injectable } from '@nestjs/common';
import { D, type Decimal, type ExitReason, type Side, type TradingMode } from '@crypto-magic/core';
import { DATABASE } from '../tokens';
import type { Db } from '../database';
import type { WorkingOrderStore } from '../ports';

/** A maker order waiting on the book, and what its fills are for. See MakerOrderService. */
export interface WorkingOrder {
  readonly productId: string;
  readonly purpose: 'entry' | 'exit';
  readonly side: Side;
  /** What was asked for, in the coin. */
  readonly baseSize: Decimal;
  /** The price the decision was sized at. */
  readonly referencePrice: Decimal;
  readonly limitPrice: Decimal;
  /** The exchange's id, or `pending:<client id>` until it acknowledges the order. */
  readonly makerOrderId: string;
  readonly makerClientOrderId: string;
  /** Fixed up front, so the market leg can never be sent twice. */
  readonly crossClientOrderId: string;
  /** Unix ms. The exchange expires the order then, and what is left goes at market. */
  readonly expiresAt: number;
  readonly reason: string;
  readonly exitReason: ExitReason | null;
  /** Entry only: the ATR the stop is set from once the position opens. */
  readonly entryAtr: Decimal | null;
  /** Open time, in seconds, of the bar that made the decision. */
  readonly barOpenTime: number;
  readonly entryReasons: string[];
  readonly confidence: number;
  readonly mode: TradingMode;
  readonly createdAt: number;
}

interface Row {
  product_id: string;
  purpose: string;
  side: string;
  base_size: string;
  reference_price: string;
  limit_price: string;
  maker_order_id: string;
  maker_client_order_id: string;
  cross_client_order_id: string;
  expires_at: number;
  reason: string;
  exit_reason: string | null;
  entry_atr: string | null;
  bar_open_time: number;
  entry_reasons: string;
  confidence: number;
  mode: string;
  created_at: number;
}

@Injectable()
export class WorkingOrderRepository implements WorkingOrderStore {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  findAll(): WorkingOrder[] {
    return this.db
      .prepare('SELECT * FROM working_orders ORDER BY created_at')
      .all()
      .map((row) => toWorkingOrder(row as Row));
  }

  find(productId: string): WorkingOrder | null {
    const row = this.db.prepare('SELECT * FROM working_orders WHERE product_id = ?').get(productId);
    return row ? toWorkingOrder(row as Row) : null;
  }

  save(order: WorkingOrder): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO working_orders (
           product_id, purpose, side, base_size, reference_price, limit_price,
           maker_order_id, maker_client_order_id, cross_client_order_id, expires_at,
           reason, exit_reason, entry_atr, bar_open_time, entry_reasons, confidence,
           mode, created_at
         ) VALUES (
           @productId, @purpose, @side, @baseSize, @referencePrice, @limitPrice,
           @makerOrderId, @makerClientOrderId, @crossClientOrderId, @expiresAt,
           @reason, @exitReason, @entryAtr, @barOpenTime, @entryReasons, @confidence,
           @mode, @createdAt
         )`,
      )
      .run({
        ...order,
        baseSize: order.baseSize.toFixed(),
        referencePrice: order.referencePrice.toFixed(),
        limitPrice: order.limitPrice.toFixed(),
        entryAtr: order.entryAtr?.toFixed() ?? null,
        entryReasons: JSON.stringify(order.entryReasons),
      });
  }

  remove(productId: string): void {
    this.db.prepare('DELETE FROM working_orders WHERE product_id = ?').run(productId);
  }
}

function toWorkingOrder(row: Row): WorkingOrder {
  return {
    productId: row.product_id,
    purpose: row.purpose === 'exit' ? 'exit' : 'entry',
    side: row.side as Side,
    baseSize: D(row.base_size),
    referencePrice: D(row.reference_price),
    limitPrice: D(row.limit_price),
    makerOrderId: row.maker_order_id,
    makerClientOrderId: row.maker_client_order_id,
    crossClientOrderId: row.cross_client_order_id,
    expiresAt: row.expires_at,
    reason: row.reason,
    exitReason: row.exit_reason === null ? null : (row.exit_reason as ExitReason),
    entryAtr: row.entry_atr === null ? null : D(row.entry_atr),
    barOpenTime: row.bar_open_time,
    entryReasons: parseReasons(row.entry_reasons),
    confidence: row.confidence,
    mode: row.mode as TradingMode,
    createdAt: row.created_at,
  };
}

function parseReasons(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
