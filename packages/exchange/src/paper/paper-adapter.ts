import { randomUUID } from 'node:crypto';
import {
  D,
  Decimal,
  floorToIncrement,
  roundPrice,
  type Candle,
  type Granularity,
  type ProductSpec,
  type Side,
  type Ticker,
} from '@crypto-magic/core';
import {
  ExchangeError,
  type Balance,
  type BestBidAsk,
  type ExchangeAdapter,
  type MakerOrderRequest,
  type MarketOrderRequest,
  type OrderResult,
  type OrderStatus,
  type ProtectiveStopRequest,
} from '../types';

export interface PaperAdapterOptions {
  /** Real adapter used for prices, candles and product rules. Paper trades real data. */
  readonly marketData: ExchangeAdapter;
  /** Starting simulated balances by currency, e.g. { USD: 1000 }. */
  readonly initialBalances: Record<string, number | string>;
  readonly takerBps?: number;
  /** Fee on a maker order that rests and fills. 40 is what EXPERIMENT-011 assumed. */
  readonly makerBps?: number;
  readonly slippageBps?: number;
  /**
   * Called with every balance after each fill, so the caller can persist the
   * simulated account. Without it, paper money lives only in memory and every
   * restart would silently reset the account and orphan open positions.
   */
  readonly onBalancesChanged?: (balances: Record<string, string>) => void;
}

/** A maker order resting on the simulated book. */
interface RestingOrder {
  readonly productId: string;
  readonly side: Side;
  readonly baseSize: Decimal;
  readonly limitPrice: Decimal;
  readonly expiresAt: number;
  readonly placedAt: number;
  readonly product: ProductSpec;
  /** What the order reserves, as Coinbase does: the cost plus fee of a buy, the coins of a sell. */
  readonly holdCurrency: string;
  readonly hold: Decimal;
}

const MINUTE_MS = 60_000;

/**
 * Simulated execution against real market data.
 *
 * Prices, candles and product rules come from the live exchange; only the money
 * is fake. Fills pay the same taker fee and adverse slippage the backtester
 * assumes, so paper results stay comparable to backtest results and to live
 * results.
 *
 * It is not a market simulator: market orders fill immediately and completely
 * at the current ticker. For the small orders this engine places in liquid
 * pairs that is close enough to be useful, and optimistic enough to be worth
 * remembering.
 *
 * Maker orders rest until the price trades THROUGH their limit on a closed
 * one-minute bar, then fill completely at the limit: EXPERIMENT-011's strict
 * rule, which assumes the order is last in the queue. A live order can also
 * fill partly, or when the price only touches it; paper does neither. Resting
 * orders live in memory, so a restart forgets them unfilled.
 */
export class PaperAdapter implements ExchangeAdapter {
  readonly name = 'paper';
  readonly isLive = false;

  private readonly balances = new Map<string, Decimal>();
  private readonly holds = new Map<string, Decimal>();
  private readonly orders = new Map<string, OrderResult>();
  private readonly byClientOrderId = new Map<string, string>();
  private readonly resting = new Map<string, RestingOrder>();
  private readonly takerBps: number;
  private readonly makerBps: number;
  private readonly slippageBps: number;
  /**
   * Different on every start. Order ids are stored with a unique key, and a
   * plain counter restarted at paper-1 after every restart: the next order then
   * collided with one from before the restart and could not be recorded, so
   * the exit it belonged to failed on every attempt.
   */
  private readonly runId = randomUUID().replace(/-/g, '').slice(0, 12);
  private sequence = 0;

  constructor(private readonly options: PaperAdapterOptions) {
    for (const [currency, amount] of Object.entries(options.initialBalances)) {
      this.balances.set(currency.toUpperCase(), D(amount));
    }
    this.takerBps = options.takerBps ?? 60;
    this.makerBps = options.makerBps ?? 40;
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

  /** The real book when the market data has one; otherwise the ticker on both sides. */
  async getBestBidAsk(productId: string): Promise<BestBidAsk> {
    if (this.options.marketData.getBestBidAsk) {
      return this.options.marketData.getBestBidAsk(productId);
    }
    const price = D((await this.getTicker(productId)).price);
    return { bid: price, ask: price };
  }

  /** Every balance as a decimal string, keyed by currency. Safe to JSON-encode. */
  balanceSnapshot(): Record<string, string> {
    return Object.fromEntries([...this.balances.entries()].map(([c, v]) => [c, v.toFixed()]));
  }

  async getBalances(): Promise<Balance[]> {
    return [...this.balances.entries()].map(([currency, total]) => {
      const hold = this.heldOf(currency);
      return { currency, available: total.minus(hold), hold };
    });
  }

  async submitMarketOrder(request: MarketOrderRequest): Promise<OrderResult> {
    // Idempotency is simulated too, so restart behaviour matches live.
    const existingId = this.byClientOrderId.get(request.clientOrderId);
    if (existingId) return this.orders.get(existingId)!;

    const product = await this.getProduct(request.productId);
    const ticker = await this.getTicker(request.productId);
    const fillPrice = applySlippage(D(ticker.price), request.side, this.slippageBps);

    // Mirror how Coinbase actually executes each side. A market BUY is sized in
    // QUOTE currency, so the dollars spent are fixed and slippage changes how
    // many coins arrive. Simulating a buy as a fixed BASE size instead would
    // spend more than the caller asked for whenever the price slipped up,
    // quietly breaching a notional cap that live trading would have respected.
    const baseSize =
      request.side === 'BUY'
        ? floorToIncrement(
            request.baseSize.mul(request.referencePrice).div(fillPrice),
            product.baseIncrement,
          )
        : floorToIncrement(request.baseSize, product.baseIncrement);

    if (baseSize.lte(0)) {
      throw new ExchangeError(`paper order size rounds to zero for ${request.productId}`);
    }

    const notional = baseSize.mul(fillPrice);
    const fee = notional.mul(this.takerBps).div(10_000);

    if (request.side === 'BUY') {
      const cost = notional.plus(fee);
      const quote = this.availableOf(product.quoteCurrency);
      if (quote.lt(cost)) {
        throw new ExchangeError(
          `paper account has ${quote.toFixed(2)} ${product.quoteCurrency}, needs ${cost.toFixed(2)}`,
        );
      }
    } else {
      const base = this.availableOf(product.baseCurrency);
      if (base.lt(baseSize)) {
        throw new ExchangeError(
          `paper account holds ${base.toFixed()} ${product.baseCurrency}, needs ${baseSize.toFixed()}`,
        );
      }
    }
    this.settle(product, request.side, baseSize, notional, fee);

    const order: OrderResult = {
      orderId: `paper-${this.runId}-${++this.sequence}`,
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

  /** A post-only limit, refused like Coinbase refuses one that would match on arrival. */
  async submitMakerOrder(request: MakerOrderRequest): Promise<OrderResult> {
    const existingId = this.byClientOrderId.get(request.clientOrderId);
    if (existingId) return this.orders.get(existingId)!;

    const product = await this.getProduct(request.productId);
    const baseSize = floorToIncrement(request.baseSize, product.baseIncrement);
    if (baseSize.lte(0)) {
      throw new ExchangeError(`paper order size rounds to zero for ${request.productId}`);
    }
    const limitPrice = roundPrice(
      request.limitPrice,
      product.quoteIncrement,
      request.side === 'BUY' ? 'down' : 'up',
    );

    const { bid, ask } = await this.getBestBidAsk(request.productId);
    if (wouldTake(request.side, limitPrice, bid, ask)) {
      throw new ExchangeError(
        `paper post-only ${request.side} at ${limitPrice.toFixed()} would take liquidity ` +
          `(bid ${bid.toFixed()}, ask ${ask.toFixed()})`,
      );
    }

    const holdCurrency = request.side === 'BUY' ? product.quoteCurrency : product.baseCurrency;
    const hold =
      request.side === 'BUY'
        ? baseSize.mul(limitPrice).mul(D(1).plus(D(this.makerBps).div(10_000)))
        : baseSize;
    const free = this.availableOf(holdCurrency);
    if (free.lt(hold)) {
      throw new ExchangeError(
        `paper account has ${free.toFixed()} ${holdCurrency} free, needs ${hold.toFixed()}`,
      );
    }
    this.holds.set(holdCurrency, this.heldOf(holdCurrency).plus(hold));

    const order: OrderResult = {
      orderId: `paper-${this.runId}-${++this.sequence}`,
      clientOrderId: request.clientOrderId,
      productId: request.productId,
      side: request.side,
      status: 'OPEN',
      filledSize: D(0),
      averageFillPrice: D(0),
      fee: D(0),
      createdAt: Date.now(),
    };
    this.orders.set(order.orderId, order);
    this.byClientOrderId.set(request.clientOrderId, order.orderId);
    this.resting.set(order.orderId, {
      productId: request.productId,
      side: request.side,
      baseSize,
      limitPrice,
      expiresAt: request.expiresAt,
      placedAt: order.createdAt,
      product,
      holdCurrency,
      hold,
    });
    return order;
  }

  async getOrder(orderId: string): Promise<OrderResult | null> {
    if (this.resting.has(orderId)) return this.refresh(orderId);
    return this.orders.get(orderId) ?? null;
  }

  async listOpenOrders(productIds?: string[]): Promise<OrderResult[]> {
    const open: OrderResult[] = [];
    for (const [orderId, order] of this.resting) {
      if (productIds && productIds.length > 0 && !productIds.includes(order.productId)) continue;
      open.push(await this.refresh(orderId));
    }
    return open.filter((o) => o.status === 'OPEN');
  }

  /**
   * Cancel resting maker orders. A fill that happened before the cancel stands,
   * as it does on the exchange. Other ids are ignored: market orders are
   * already filled, and protective stops are never triggered in paper.
   */
  async cancelOrders(orderIds: string[]): Promise<void> {
    for (const orderId of orderIds) {
      if (!this.resting.has(orderId)) continue;
      await this.refresh(orderId);
      const resting = this.resting.get(orderId);
      if (resting) this.close(orderId, resting, 'CANCELLED');
    }
  }

  /** Accepted and recorded, but never triggered — the engine enforces stops in paper mode. */
  async submitProtectiveStop(request: ProtectiveStopRequest): Promise<OrderResult> {
    const order: OrderResult = {
      orderId: `paper-stop-${this.runId}-${++this.sequence}`,
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

  /** Fill a resting order if the market traded through it; expire it once its time is up. */
  private async refresh(orderId: string): Promise<OrderResult> {
    const resting = this.resting.get(orderId)!;
    const now = Date.now();
    if (await this.tradedThrough(resting, Math.min(now, resting.expiresAt))) {
      return this.fill(orderId, resting);
    }
    if (now >= resting.expiresAt) return this.close(orderId, resting, 'EXPIRED');
    return this.orders.get(orderId)!;
  }

  /**
   * EXPERIMENT-011's strict rule on closed one-minute bars: a buy fills once the
   * price trades below its limit, a sell once it trades above. Touching the
   * limit is not enough, since the order may be last in the queue. Only bars
   * wholly inside the order's life count, so the first and last part-minutes
   * are ignored: a little pessimistic, never optimistic.
   */
  private async tradedThrough(resting: RestingOrder, until: number): Promise<boolean> {
    const from = Math.ceil(resting.placedAt / MINUTE_MS) * MINUTE_MS;
    if (until - from < MINUTE_MS) return false;
    const bars = await this.options.marketData.getCandles({
      productId: resting.productId,
      granularity: 'ONE_MINUTE',
      start: from / 1000,
      end: Math.floor(until / 1000),
    });
    return bars.some((bar) => {
      const opened = bar.openTime * 1000;
      if (bar.granularity !== 'ONE_MINUTE' || opened < from || opened + MINUTE_MS > until) {
        return false;
      }
      return resting.side === 'BUY'
        ? D(bar.low).lt(resting.limitPrice)
        : D(bar.high).gt(resting.limitPrice);
    });
  }

  private fill(orderId: string, resting: RestingOrder): OrderResult {
    this.release(resting);
    this.resting.delete(orderId);
    const notional = resting.baseSize.mul(resting.limitPrice);
    const fee = notional.mul(this.makerBps).div(10_000);
    this.settle(resting.product, resting.side, resting.baseSize, notional, fee);
    return this.update(orderId, {
      status: 'FILLED',
      filledSize: resting.baseSize,
      averageFillPrice: resting.limitPrice,
      fee,
    });
  }

  private close(orderId: string, resting: RestingOrder, status: OrderStatus): OrderResult {
    this.release(resting);
    this.resting.delete(orderId);
    return this.update(orderId, { status });
  }

  private release(resting: RestingOrder): void {
    const left = this.heldOf(resting.holdCurrency).minus(resting.hold);
    if (left.gt(0)) this.holds.set(resting.holdCurrency, left);
    else this.holds.delete(resting.holdCurrency);
  }

  private update(orderId: string, changes: Partial<OrderResult>): OrderResult {
    const updated = { ...this.orders.get(orderId)!, ...changes };
    this.orders.set(orderId, updated);
    return updated;
  }

  /** Move the money for a fill: coins one way, their price and the fee the other. */
  private settle(
    product: ProductSpec,
    side: Side,
    baseSize: Decimal,
    notional: Decimal,
    fee: Decimal,
  ): void {
    const base = product.baseCurrency;
    const quote = product.quoteCurrency;
    if (side === 'BUY') {
      this.balances.set(quote, this.balanceOf(quote).minus(notional).minus(fee));
      this.balances.set(base, this.balanceOf(base).plus(baseSize));
    } else {
      this.balances.set(base, this.balanceOf(base).minus(baseSize));
      this.balances.set(quote, this.balanceOf(quote).plus(notional).minus(fee));
    }
    this.options.onBalancesChanged?.(this.balanceSnapshot());
  }

  private balanceOf(currency: string): Decimal {
    return this.balances.get(currency.toUpperCase()) ?? D(0);
  }

  private heldOf(currency: string): Decimal {
    return this.holds.get(currency.toUpperCase()) ?? D(0);
  }

  private availableOf(currency: string): Decimal {
    return this.balanceOf(currency).minus(this.heldOf(currency));
  }
}

function applySlippage(price: Decimal, side: 'BUY' | 'SELL', bps: number): Decimal {
  const factor = D(bps).div(10_000);
  return side === 'BUY' ? price.mul(D(1).plus(factor)) : price.mul(D(1).minus(factor));
}

/**
 * Whether a limit would match on arrival. With a real spread, a buy at the ask
 * or a sell at the bid would. With only a ticker (bid equal to ask), a limit
 * at that price is allowed to rest.
 */
function wouldTake(side: Side, limit: Decimal, bid: Decimal, ask: Decimal): boolean {
  const spread = ask.gt(bid);
  if (side === 'BUY') return spread ? limit.gte(ask) : limit.gt(ask);
  return spread ? limit.lte(bid) : limit.lt(bid);
}
