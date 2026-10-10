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
 * A post-only limit order that the exchange itself cancels at `expiresAt`.
 *
 * Post-only: the exchange refuses it, rather than filling it, if it would take
 * liquidity on arrival, so it can only ever pay the maker fee. EXPERIMENT-011.
 */
export interface MakerOrderRequest {
  readonly productId: string;
  readonly side: Side;
  /** Base quantity, for both sides: a limit order is sized in the coin. */
  readonly baseSize: Decimal;
  readonly limitPrice: Decimal;
  /** Unix ms. Whatever has not filled by then is cancelled by the exchange. */
  readonly expiresAt: number;
  readonly clientOrderId: string;
}

/** The top of the order book. */
export interface BestBidAsk {
  readonly bid: Decimal;
  readonly ask: Decimal;
}

/**
 * Everything the engine is allowed to do to an exchange.
 *
 * Deliberately narrow: no margin, no leverage, no shorting, and no order types
 * beyond market, a protective stop-limit, and a post-only limit that the
 * exchange expires within the hour. Anything not on this interface is something
 * the bot cannot do to your account, whatever the strategy asks for.
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

  /** The top of the book, to price a maker order at the touch. */
  getBestBidAsk?(productId: string): Promise<BestBidAsk>;

  /**
   * A post-only limit order the exchange expires on its own, so it cannot rest
   * past `expiresAt` even if this process dies. Only used with MAKER_ORDERS on,
   * for the strategy's own entries and signal exits.
   */
  submitMakerOrder?(request: MakerOrderRequest): Promise<OrderResult>;
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
