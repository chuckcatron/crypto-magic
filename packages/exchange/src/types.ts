import type { Candle, Decimal, Granularity, ProductSpec, Side, Ticker } from '@crypto-magic/core';

export interface Balance {
  readonly currency: string;
  readonly available: Decimal;
  readonly hold: Decimal;
}

export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export interface OrderResult {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly productId: string;
  readonly side: Side;
  readonly status: OrderStatus;
  /** Base quantity actually filled. Zero until the exchange reports a fill. */
  readonly filledSize: Decimal;
  readonly averageFillPrice: Decimal;
  readonly fee: Decimal;
  readonly createdAt: number;
  readonly rejectReason?: string;
}

export interface MarketOrderRequest {
  readonly productId: string;
  readonly side: Side;
  /** Base quantity. For a BUY this is converted to a quote amount — see the adapter. */
  readonly baseSize: Decimal;
  /** Used to convert a BUY's base size into a quote amount, and to check slippage. */
  readonly referencePrice: Decimal;
  /**
   * Caller-supplied stable ID. Submitting the same key twice must not produce
   * two orders — this is the only thing standing between a restart loop and a
   * duplicated position.
   */
  readonly clientOrderId: string;
}

export interface ProtectiveStopRequest {
  readonly productId: string;
  readonly baseSize: Decimal;
  readonly stopPrice: Decimal;
  /** Limit price for the triggered order, set below stopPrice to improve fill odds. */
  readonly limitPrice: Decimal;
  readonly clientOrderId: string;
}

/**
 * Everything the engine is allowed to do to an exchange.
 *
 * Deliberately narrow: no margin, no leverage, no shorting, no order types
 * beyond market and a protective stop-limit. Anything not on this interface is
 * something the bot cannot do to your account, whatever the strategy asks for.
 */
export interface ExchangeAdapter {
  readonly name: string;
  /** False for the paper adapter. The engine logs this on every order. */
  readonly isLive: boolean;

  getProduct(productId: string): Promise<ProductSpec>;
  getCandles(args: {
    productId: string;
    granularity: Granularity;
    start: number;
    end: number;
  }): Promise<Candle[]>;
  getTicker(productId: string): Promise<Ticker>;
  getBalances(): Promise<Balance[]>;

  submitMarketOrder(request: MarketOrderRequest): Promise<OrderResult>;
  getOrder(orderId: string): Promise<OrderResult | null>;
  /** Orders resting on the book, used to reconcile after a restart. */
  listOpenOrders(productIds?: string[]): Promise<OrderResult[]>;
  cancelOrders(orderIds: string[]): Promise<void>;

  /**
   * Exchange-side stop that survives this process dying. The engine's own
   * trailing stop is tighter; this is the backstop for when the bot is not
   * running to enforce it.
   */
  submitProtectiveStop?(request: ProtectiveStopRequest): Promise<OrderResult>;
}

export class ExchangeError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
    /** True when a retry could plausibly succeed (network, 5xx, rate limit). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
}
