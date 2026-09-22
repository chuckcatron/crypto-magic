import { Inject, Injectable } from '@nestjs/common';
import { D, type Decimal, type ExitReason, type Side, type TradingMode } from '@crypto-magic/core';
import type { OrderStatus } from '@crypto-magic/exchange';
import { DATABASE } from '../tokens';
import type { Db } from '../database';

export interface StoredOrder {
  orderId: string;
  clientOrderId: string;
  productId: string;
  side: Side;
  status: OrderStatus;
  requestedBaseSize: Decimal;
  filledSize: Decimal;
  averageFillPrice: Decimal;
  fee: Decimal;
  referencePrice: Decimal;
  reason: string | null;
  exitReason: ExitReason | null;
  mode: TradingMode;
  createdAt: number;
  updatedAt: number;
}

@Injectable()
export class OrderRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /**
   * The idempotency lookup. Before submitting anything, the executor asks
   * whether this client order id has been used; a hit means a previous attempt
   * already reached the exchange and must not be repeated.
   */
  findByClientOrderId(clientOrderId: string): StoredOrder | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE client_order_id = ?').get(clientOrderId);
    return row ? toOrder(row as never) : null;
  }

  /**
   * Upsert keyed on `client_order_id`, not `order_id`.
   *
   * The executor writes a placeholder row before it reaches the network, using
   * a synthetic `pending:` order id, and rewrites it with the exchange's real
   * id once the order is acknowledged. Conflicting on `order_id` would treat
   * that as a brand new row and trip the unique index on `client_order_id`.
   * The client order id is the stable identity of an order attempt; the
   * exchange's id is not known until later.
   */
  save(order: StoredOrder): void {
    this.db
      .prepare(
        `INSERT INTO orders (
           order_id, client_order_id, product_id, side, status, requested_base_size,
           filled_size, average_fill_price, fee, reference_price, reason, exit_reason,
           mode, created_at, updated_at
         ) VALUES (
           @orderId, @clientOrderId, @productId, @side, @status, @requestedBaseSize,
           @filledSize, @averageFillPrice, @fee, @referencePrice, @reason, @exitReason,
           @mode, @createdAt, @updatedAt
         )
         ON CONFLICT(client_order_id) DO UPDATE SET
           order_id = excluded.order_id,
           status = excluded.status,
           filled_size = excluded.filled_size,
           average_fill_price = excluded.average_fill_price,
           fee = excluded.fee,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...order,
        requestedBaseSize: order.requestedBaseSize.toFixed(),
        filledSize: order.filledSize.toFixed(),
        averageFillPrice: order.averageFillPrice.toFixed(),
        fee: order.fee.toFixed(),
        referencePrice: order.referencePrice.toFixed(),
      });
  }

  countSince(sinceMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?')
      .get(sinceMs) as { n: number };
    return row.n;
  }

  recent(limit = 50): StoredOrder[] {
    return this.db
      .prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((row) => toOrder(row as never));
  }
}

function toOrder(row: Record<string, string | number | null>): StoredOrder {
  return {
    orderId: String(row.order_id),
    clientOrderId: String(row.client_order_id),
    productId: String(row.product_id),
    side: row.side as Side,
    status: row.status as OrderStatus,
    requestedBaseSize: D(String(row.requested_base_size)),
    filledSize: D(String(row.filled_size)),
    averageFillPrice: D(String(row.average_fill_price)),
    fee: D(String(row.fee)),
    referencePrice: D(String(row.reference_price)),
    reason: row.reason === null ? null : String(row.reason),
    exitReason: row.exit_reason === null ? null : (String(row.exit_reason) as ExitReason),
    mode: row.mode as TradingMode,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
