import type { Decimal } from '@crypto-magic/core';
import type { StoredEvent } from './repositories/event.repository';
import type { StoredOrder } from './repositories/order.repository';
import type { StoredPosition } from './repositories/position.repository';
import type { EquitySnapshot } from './repositories/state.repository';
import type { StoredTradeAnalysis } from './repositories/trade-analysis.repository';
import type { StoredTrade } from './repositories/trade.repository';

/**
 * The storage contract.
 *
 * Everything the engine needs from a database, stated without reference to
 * SQLite. The shipped implementations are the SQLite repositories, which is the
 * right default for a bot running on one machine: no server to keep alive, the
 * whole trade history in one file you can copy, and transactions that actually
 * mean something.
 *
 * Swapping in another backend — DynamoDB, Postgres — means writing classes that
 * satisfy these interfaces and overriding the providers in PersistenceModule:
 *
 *   { provide: PositionRepository, useClass: DynamoPositionStore }
 *
 * Nest resolves by the concrete class as token, so nothing else changes. Note
 * that these are SYNCHRONOUS: better-sqlite3 is a synchronous driver and the
 * engine leans on that for read-modify-write of a position within one tick. A
 * network-backed store would need these to return promises, which is a real
 * refactor of the call sites, not a drop-in. That is a deliberate trade for a
 * local-first design, and it is worth knowing before betting on the swap.
 */
export interface PositionStore {
  findAll(): StoredPosition[];
  find(productId: string): StoredPosition | null;
  upsert(position: StoredPosition): void;
  remove(productId: string): void;
}

export interface OrderStore {
  /** The idempotency lookup. Must be exact and must never miss. */
  findByClientOrderId(clientOrderId: string): StoredOrder | null;
  save(order: StoredOrder): void;
  countSince(sinceMs: number): number;
  recent(limit?: number): StoredOrder[];
}

export interface TradeStore {
  insert(trade: StoredTrade): void;
  findById(id: number): StoredTrade | null;
  realizedPnlSince(sinceMs: number): Decimal;
  consecutiveLosses(): number;
  recent(limit?: number): StoredTrade[];
  all(): StoredTrade[];
}

export interface EventStore {
  append(event: Omit<StoredEvent, 'id' | 'ts'> & { ts?: number }): void;
  recent(limit?: number): StoredEvent[];
}

export interface StateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  recordEquity(snapshot: EquitySnapshot): void;
  equityCurve(limit?: number): EquitySnapshot[];
}

export interface TradeAnalysisStore {
  find(tradeId: number): StoredTradeAnalysis | null;
  findMany(tradeIds: number[]): Map<number, StoredTradeAnalysis>;
  save(analysis: StoredTradeAnalysis): void;
  recordFailure(tradeId: number, error: string): void;
  pendingTradeIds(limit: number): number[];
  countPending(): number;
}
