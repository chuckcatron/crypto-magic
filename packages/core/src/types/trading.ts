import type { Decimal } from '../money';

export type Side = 'BUY' | 'SELL';

export type TradingMode = 'paper' | 'live';

/** Why a position was closed. Recorded on every exit for later analysis. */
export type ExitReason =
  | 'signal'
  | 'stop_loss'
  | 'trailing_stop'
  | 'take_profit'
  | 'max_holding_period'
  | 'kill_switch'
  | 'risk_flatten'
  | 'manual';

/**
 * A strategy's request to change exposure. It is a *request*: the risk engine
 * may shrink it or reject it outright, and only the executor turns it into an
 * exchange order.
 */
export interface OrderIntent {
  readonly productId: string;
  readonly side: Side;
  /** Base asset quantity. */
  readonly baseSize: Decimal;
  /** Reference price used for sizing and notional checks (last close). */
  readonly referencePrice: Decimal;
  readonly reason: string;
  readonly exitReason?: ExitReason;
  /** Stable key for deduplication — same key must never place two orders. */
  readonly idempotencyKey: string;
}

export interface Fill {
  readonly orderId: string;
  readonly productId: string;
  readonly side: Side;
  readonly baseSize: Decimal;
  readonly price: Decimal;
  readonly fee: Decimal;
  readonly timestamp: number;
}

export interface Position {
  readonly productId: string;
  /** Always > 0 for an open position. Spot only — long or flat, never short. */
  readonly baseSize: Decimal;
  readonly averageEntryPrice: Decimal;
  readonly openedAt: number;
  /** Hard stop; breaching it exits at market. */
  readonly stopPrice: Decimal;
  /** Highest close seen since entry, used to ratchet the trailing stop. */
  readonly highWaterPrice: Decimal;
  readonly takeProfitPrice: Decimal | null;
  readonly entryAtr: Decimal;
}

export type SignalAction = 'ENTER_LONG' | 'EXIT_LONG' | 'HOLD';

export interface Signal {
  readonly action: SignalAction;
  /** 0..1. Used for sizing scale-in, and logged for post-hoc analysis. */
  readonly confidence: number;
  /** Human-readable justifications — these end up in the trade log verbatim. */
  readonly reasons: string[];
  readonly exitReason?: ExitReason;
  /** Indicator snapshot at decision time, persisted for debugging. */
  readonly indicators: Record<string, number | null>;
}

export const HOLD: Signal = {
  action: 'HOLD',
  confidence: 0,
  reasons: [],
  indicators: {},
};
