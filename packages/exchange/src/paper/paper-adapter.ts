import { D, Decimal, floorToIncrement, type Candle, type Granularity, type ProductSpec, type Ticker } from '@crypto-magic/core';
import {
  ExchangeError,
  type Balance,
  type ExchangeAdapter,
  type MarketOrderRequest,
  type OrderResult,
  type ProtectiveStopRequest,
} from '../types';

export interface PaperAdapterOptions {
  /** Real adapter used for prices, candles and product rules. Paper trades real data. */
  readonly marketData: ExchangeAdapter;
  /** Starting simulated balances by currency, e.g. { USD: 1000 }. */
  readonly initialBalances: Record<string, number | string>;
  readonly takerBps?: number;
  readonly slippageBps?: number;
}

/**
 * Simulated execution against real market data.
 *
 * Prices, candles and product rules come from the live exchange; only the money
 * is fake. Fills pay the same taker fee and adverse slippage the backtester
 * assumes, so paper results stay comparable to backtest results and to live
 * results.
 *
 * It is not a market simulator: fills are immediate and complete at the current
 * ticker. For the small orders this engine places in liquid pairs that is close
 * enough to be useful, and optimistic enough to be worth remembering.
 */
export class PaperAdapter implements ExchangeAdapter {
  readonly name = 'paper';
  readonly isLive = false;

  private readonly balances = new Map<string, Decimal>();
  private readonly orders = new Map<string, OrderResult>();
  private readonly byClientOrderId = new Map<string, string>();
  private readonly takerBps: number;
  private readonly slippageBps: number;
  private sequence = 0;

  constructor(private readonly options: PaperAdapterOptions) {
    for (const [currency, amount] of Object.entries(options.initialBalances)) {
      this.balances.set(currency.toUpperCase(), D(amount));
    }
    this.takerBps = options.takerBps ?? 60;
    this.slippageBps = options.slippageBps ?? 5;
  }

  getProduct(productId: string): Promise<ProductSpec> {
    return this.options.marketData.getProduct(productId);
  }

  getCandles(args: {
    productId: string;
    granularity: Granularity;
    start: number;
    end: number;
  }): Promise<Candle[]> {
    return this.options.marketData.getCandles(args);
  }

  getTicker(productId: string): Promise<Ticker> {
    return this.options.marketData.getTicker(productId);
  }

  async getBalances(): Promise<Balance[]> {
    return [...this.balances.entries()].map(([currency, available]) => ({
      currency,
      available,
      hold: D(0),
    }));
  }

  async submitMarketOrder(request: MarketOrderRequest): Promise<OrderResult> {
    // Idempotency is simulated too, so restart behaviour matches live.
    const existingId = this.byClientOrderId.get(request.clientOrderId);
    if (existingId) return this.orders.get(existingId)!;

    const product = await this.getProduct(request.productId);
    const ticker = await this.getTicker(request.productId);
    const fillPrice = applySlippage(D(ticker.price), request.side, this.slippageBps);
    const baseSize = floorToIncrement(request.baseSize, product.baseIncrement);

    if (baseSize.lte(0)) {
      throw new ExchangeError(`paper order size rounds to zero for ${request.productId}`);
    }

    const notional = baseSize.mul(fillPrice);
    const fee = notional.mul(this.takerBps).div(10_000);

    if (request.side === 'BUY') {
      const cost = notional.plus(fee);
      const quote = this.balanceOf(product.quoteCurrency);
      if (quote.lt(cost)) {
        throw new ExchangeError(
          `paper account has ${quote.toFixed(2)} ${product.quoteCurrency}, needs ${cost.toFixed(2)}`,
        );
      }
      this.balances.set(product.quoteCurrency, quote.minus(cost));
      this.balances.set(product.baseCurrency, this.balanceOf(product.baseCurrency).plus(baseSize));
    } else {
      const base = this.balanceOf(product.baseCurrency);
      if (base.lt(baseSize)) {
        throw new ExchangeError(
          `paper account holds ${base.toFixed()} ${product.baseCurrency}, needs ${baseSize.toFixed()}`,
        );
      }
      this.balances.set(product.baseCurrency, base.minus(baseSize));
      this.balances.set(
        product.quoteCurrency,
        this.balanceOf(product.quoteCurrency).plus(notional).minus(fee),
      );
    }

    const order: OrderResult = {
      orderId: `paper-${++this.sequence}`,
      clientOrderId: request.clientOrderId,
      productId: request.productId,
      side: request.side,
      status: 'FILLED',
      filledSize: baseSize,
      averageFillPrice: fillPrice,
      fee,
      createdAt: Date.now(),
    };
    this.orders.set(order.orderId, order);
    this.byClientOrderId.set(request.clientOrderId, order.orderId);
    return order;
  }

  async getOrder(orderId: string): Promise<OrderResult | null> {
    return this.orders.get(orderId) ?? null;
  }

  /** Paper fills are immediate, so nothing ever rests on the book. */
  async listOpenOrders(): Promise<OrderResult[]> {
    return [];
  }

  async cancelOrders(): Promise<void> {
    // Nothing to cancel: every paper order fills or throws at submission.
  }

  /** Accepted and recorded, but never triggered — the engine enforces stops in paper mode. */
  async submitProtectiveStop(request: ProtectiveStopRequest): Promise<OrderResult> {
    const order: OrderResult = {
      orderId: `paper-stop-${++this.sequence}`,
      clientOrderId: request.clientOrderId,
      productId: request.productId,
      side: 'SELL',
      status: 'OPEN',
      filledSize: D(0),
      averageFillPrice: D(0),
      fee: D(0),
      createdAt: Date.now(),
    };
    this.orders.set(order.orderId, order);
    return order;
  }

  private balanceOf(currency: string): Decimal {
    return this.balances.get(currency.toUpperCase()) ?? D(0);
  }
}

function applySlippage(price: Decimal, side: 'BUY' | 'SELL', bps: number): Decimal {
  const factor = D(bps).div(10_000);
  return side === 'BUY' ? price.mul(D(1).plus(factor)) : price.mul(D(1).minus(factor));
}
