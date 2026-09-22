import { CBAdvancedTradeClient } from 'coinbase-api';
import {
  D,
  GRANULARITY_SECONDS,
  floorToIncrement,
  roundPrice,
  toApiString,
  type Candle,
  type Granularity,
  type ProductSpec,
  type Ticker,
} from '@crypto-magic/core';
import {
  ExchangeError,
  type Balance,
  type ExchangeAdapter,
  type MarketOrderRequest,
  type OrderResult,
  type ProtectiveStopRequest,
} from '../types';
import { toCandle, toOrderResult, toProductSpec } from './mapping';

/** Coinbase caps a single candles request at 350 buckets. */
const MAX_CANDLES_PER_REQUEST = 350;

/**
 * The SDK requires client order IDs to carry this prefix, and silently adds it
 * when missing. We add it ourselves so the ID we store locally is byte-identical
 * to the one the exchange knows — otherwise idempotency lookups miss.
 */
const CLIENT_ORDER_ID_PREFIX = 'cbnode';

export interface CoinbaseAdapterOptions {
  /**
   * CDP API key name, e.g. "organizations/{org}/apiKeys/{key}".
   *
   * Omit both credentials to get a market-data-only adapter backed by
   * Coinbase's public endpoints. That is what paper mode uses, so you can run
   * the bot against real prices before creating an API key at all — and an
   * adapter with no credentials physically cannot place an order.
   */
  readonly apiKey?: string;
  /** CDP private key PEM, including the BEGIN/END lines. */
  readonly apiSecret?: string;
  readonly maxRetries?: number;
}

/**
 * Coinbase Advanced Trade adapter.
 *
 * Only ever places market IOC orders and optional protective stop-limits. It
 * cannot short, cannot use margin, and cannot place anything that rests on the
 * book indefinitely.
 */
export class CoinbaseAdapter implements ExchangeAdapter {
  readonly name = 'coinbase-advanced-trade';

  /** Only an authenticated adapter can actually move money. */
  get isLive(): boolean {
    return this.authenticated;
  }

  private readonly client: CBAdvancedTradeClient;
  private readonly maxRetries: number;
  private readonly productCache = new Map<string, { spec: ProductSpec; fetchedAt: number }>();
  /** False when constructed without credentials: reads work, orders cannot. */
  readonly authenticated: boolean;

  constructor(options: CoinbaseAdapterOptions) {
    const hasKey = Boolean(options.apiKey);
    const hasSecret = Boolean(options.apiSecret);
    if (hasKey !== hasSecret) {
      throw new ExchangeError(
        'Coinbase adapter needs both an API key name and a private key, or neither',
      );
    }
    this.authenticated = hasKey && hasSecret;
    this.client = new CBAdvancedTradeClient(
      this.authenticated ? { apiKey: options.apiKey, apiSecret: options.apiSecret } : {},
    );
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Fetch a product from whichever endpoint this adapter is entitled to use.
   *
   * The authenticated and public responses are different SDK types that differ
   * only in futures fields we never read, so both are narrowed to the subset
   * the mapper actually needs.
   */
  private async fetchProduct(productId: string): Promise<RawProduct> {
    return this.call(async () =>
      this.authenticated
        ? ((await this.client.getProduct({ product_id: productId })) as RawProduct)
        : ((await this.client.getPublicProduct({ product_id: productId })) as RawProduct),
    );
  }

  /** Guard on every method that moves money or reads private account state. */
  private requireCredentials(operation: string): void {
    if (!this.authenticated) {
      throw new ExchangeError(
        `${operation} requires Coinbase API credentials; this adapter was built for public market data only`,
      );
    }
  }

  async getProduct(productId: string): Promise<ProductSpec> {
    // Product rules change rarely; a short cache keeps order submission off the
    // network path without letting a delisting go unnoticed for long.
    const cached = this.productCache.get(productId);
    if (cached && Date.now() - cached.fetchedAt < 15 * 60_000) return cached.spec;

    const raw = await this.fetchProduct(productId);
    const spec = toProductSpec(raw);
    this.productCache.set(productId, { spec, fetchedAt: Date.now() });
    return spec;
  }

  /**
   * Fetch closed candles in ascending time order.
   *
   * Requests are chunked to the 350-bucket API limit and the final in-progress
   * bucket is dropped: acting on a bar that is still forming produces decisions
   * that cannot be reproduced and do not survive to the bar's close.
   */
  async getCandles(args: {
    productId: string;
    granularity: Granularity;
    start: number;
    end: number;
  }): Promise<Candle[]> {
    const step = GRANULARITY_SECONDS[args.granularity];
    const collected: Candle[] = [];

    for (let from = args.start; from < args.end; from += step * MAX_CANDLES_PER_REQUEST) {
      const to = Math.min(args.end, from + step * MAX_CANDLES_PER_REQUEST);
      const params = {
        product_id: args.productId,
        granularity: args.granularity,
        start: String(from),
        end: String(to),
        limit: MAX_CANDLES_PER_REQUEST,
      };
      const response = await this.call(() =>
        this.authenticated
          ? this.client.getProductCandles(params)
          : this.client.getPublicProductCandles(params),
      );
      for (const raw of response.candles ?? []) {
        collected.push(toCandle(raw, args.productId, args.granularity));
      }
    }

    const nowBucket = Math.floor(Date.now() / 1000 / step) * step;
    const byTime = new Map<number, Candle>();
    for (const candle of collected) {
      if (candle.openTime >= nowBucket) continue; // still forming
      if (!Number.isFinite(candle.close) || candle.close <= 0) continue; // malformed
      byTime.set(candle.openTime, candle);
    }
    return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
  }

  async getTicker(productId: string): Promise<Ticker> {
    const raw = await this.fetchProduct(productId);
    const price = Number.parseFloat(raw.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new ExchangeError(`Coinbase returned a nonsensical price for ${productId}: ${raw.price}`);
    }
    return { productId, price, timestamp: Date.now() };
  }

  async getBalances(): Promise<Balance[]> {
    this.requireCredentials('reading balances');
    const balances: Balance[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.call(() =>
        this.client.getAccounts({ limit: 250, ...(cursor ? { cursor } : {}) }),
      );
      for (const account of page.accounts ?? []) {
        balances.push({
          currency: account.currency,
          available: D(account.available_balance?.value ?? '0'),
          hold: D(account.hold?.value ?? '0'),
        });
      }
      cursor = page.has_next ? page.cursor : undefined;
    } while (cursor);

    return balances;
  }

  /**
   * Submit a market IOC order.
   *
   * Coinbase specifies market BUYs in QUOTE currency and market SELLs in BASE
   * currency. Getting this backwards on a buy would size the order in coins
   * instead of dollars, so the conversion happens here, once.
   *
   * The response carries only an order ID — no fill data. Callers must poll
   * `getOrder` to learn the actual fill price.
   */
  async submitMarketOrder(request: MarketOrderRequest): Promise<OrderResult> {
    this.requireCredentials('submitting an order');
    const product = await this.getProduct(request.productId);
    if (product.tradingDisabled) {
      throw new ExchangeError(`trading is disabled for ${request.productId}`);
    }

    const clientOrderId = withPrefix(request.clientOrderId);
    const orderConfiguration =
      request.side === 'BUY'
        ? {
            market_market_ioc: {
              quote_size: toApiString(
                roundPrice(
                  request.baseSize.mul(request.referencePrice),
                  product.quoteIncrement,
                  'down',
                ),
                product.quoteIncrement,
              ),
            },
          }
        : {
            market_market_ioc: {
              base_size: toApiString(
                floorToIncrement(request.baseSize, product.baseIncrement),
                product.baseIncrement,
              ),
            },
          };

    const response = await this.call(
      () =>
        this.client.submitOrder({
          client_order_id: clientOrderId,
          product_id: request.productId,
          side: request.side,
          order_configuration: orderConfiguration,
        }),
      { retry: false },
    );

    if (!response.success || !response.success_response) {
      const error = response.error_response;
      throw new ExchangeError(
        `Coinbase rejected the ${request.side} order for ${request.productId}: ` +
          `${error?.new_order_failure_reason ?? 'unknown'} ${error?.message ?? ''}`.trim(),
      );
    }

    const { order_id: orderId } = response.success_response;
    // A market IOC settles fast, but "fast" is not "synchronous". Fetch the real
    // fill rather than assuming the reference price.
    const settled = await this.getOrder(orderId);
    return (
      settled ?? {
        orderId,
        clientOrderId,
        productId: request.productId,
        side: request.side,
        status: 'PENDING',
        filledSize: D(0),
        averageFillPrice: D(0),
        fee: D(0),
        createdAt: Date.now(),
      }
    );
  }

  async getOrder(orderId: string): Promise<OrderResult | null> {
    this.requireCredentials('reading an order');
    try {
      const response = await this.call(() => this.client.getOrder({ order_id: orderId }));
      return response.order ? toOrderResult(response.order) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listOpenOrders(productIds?: string[]): Promise<OrderResult[]> {
    this.requireCredentials('listing open orders');
    const response = await this.call(() =>
      this.client.getOrders({
        order_status: ['OPEN', 'PENDING'],
        ...(productIds && productIds.length > 0 ? { product_ids: productIds } : {}),
        limit: 250,
      }),
    );
    return (response.orders ?? []).map(toOrderResult);
  }

  async cancelOrders(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return;
    this.requireCredentials('cancelling orders');
    const response = await this.call(() => this.client.cancelOrders({ order_ids: orderIds }));
    const failures = (response.results ?? []).filter((r) => !r.success);
    if (failures.length > 0) {
      throw new ExchangeError(
        `Coinbase refused to cancel ${failures.length} order(s): ` +
          failures.map((f) => `${f.order_id} (${f.failure_reason})`).join(', '),
      );
    }
  }

  /**
   * Place a stop-limit that lives on the exchange, so an open position still has
   * a floor if this process dies. The limit sits below the trigger to improve
   * the odds of filling in a fast move.
   */
  async submitProtectiveStop(request: ProtectiveStopRequest): Promise<OrderResult> {
    this.requireCredentials('placing a protective stop');
    const product = await this.getProduct(request.productId);
    const response = await this.call(
      () =>
        this.client.submitOrder({
          client_order_id: withPrefix(request.clientOrderId),
          product_id: request.productId,
          side: 'SELL',
          order_configuration: {
            stop_limit_stop_limit_gtc: {
              base_size: toApiString(
                floorToIncrement(request.baseSize, product.baseIncrement),
                product.baseIncrement,
              ),
              stop_price: toApiString(
                roundPrice(request.stopPrice, product.quoteIncrement, 'down'),
                product.quoteIncrement,
              ),
              limit_price: toApiString(
                roundPrice(request.limitPrice, product.quoteIncrement, 'down'),
                product.quoteIncrement,
              ),
              stop_direction: 'STOP_DIRECTION_STOP_DOWN',
            },
          },
        }),
      { retry: false },
    );

    if (!response.success || !response.success_response) {
      throw new ExchangeError(
        `Coinbase rejected the protective stop for ${request.productId}: ` +
          `${response.error_response?.new_order_failure_reason ?? 'unknown'}`,
      );
    }
    const settled = await this.getOrder(response.success_response.order_id);
    if (!settled) throw new ExchangeError('protective stop accepted but could not be read back');
    return settled;
  }

  /**
   * Run an API call, retrying transient failures with exponential backoff.
   *
   * Pass `{ retry: false }` for anything that PLACES an order. The failures
   * worth retrying on a read — a reset connection, a timeout, a 5xx — are
   * exactly the ones where an order submission is AMBIGUOUS: Coinbase may
   * already have accepted it and we simply never saw the reply. Retrying then
   * is how one intended position becomes two.
   *
   * The comment on this method used to promise submissions were never retried
   * while both submitOrder call sites went through the retrying path anyway.
   * Found in the security review. The executor's own "ambiguous failure →
   * engage the kill switch and let a human check the exchange" logic depends on
   * seeing the FIRST failure, not the fourth.
   */
  private async call<T>(operation: () => Promise<T>, options: { retry?: boolean } = {}): Promise<T> {
    const maxRetries = options.retry === false ? 0 : this.maxRetries;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === maxRetries) break;
        await sleep(2 ** attempt * 500 + Math.random() * 250);
      }
    }
    throw new ExchangeError(
      `Coinbase request failed: ${describeError(lastError)}`,
      lastError,
      isRetryable(lastError),
    );
  }
}

/** The fields of a Coinbase product response this adapter actually reads. */
interface RawProduct {
  product_id: string;
  price: string;
  base_name: string;
  quote_name: string;
  base_increment: string;
  quote_increment: string;
  quote_min_size: string;
  trading_disabled: boolean;
  is_disabled?: boolean;
  cancel_only?: boolean;
  limit_only?: boolean;
  status?: string;
}

function withPrefix(clientOrderId: string): string {
  return clientOrderId.startsWith(CLIENT_ORDER_ID_PREFIX)
    ? clientOrderId
    : `${CLIENT_ORDER_ID_PREFIX}${clientOrderId}`;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404;
}

function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status === 429 || status >= 500;
  const code = (error as { code?: string } | null)?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED'
  );
}

/**
 * Compact, single-line description of an SDK error.
 *
 * The SDK rejects with a large object carrying the whole request — headers,
 * client options, every parameter. Serializing that wholesale produces a ~900
 * character log line, and a bot that retries every 30 seconds for a year writes
 * it about a million times. Keep the parts that identify the failure.
 */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const e = error as {
      code?: unknown;
      message?: unknown;
      body?: unknown;
      requestParams?: { method?: unknown; endpoint?: unknown };
    };
    const parts: string[] = [];
    if (e.code !== undefined) parts.push(`HTTP ${String(e.code)}`);
    if (typeof e.message === 'string' && e.message) parts.push(e.message);
    if (e.requestParams?.endpoint) {
      parts.push(`(${String(e.requestParams.method ?? 'GET')} ${String(e.requestParams.endpoint)})`);
    }
    if (typeof e.body === 'string' && e.body) parts.push(`- ${truncate(e.body, 160)}`);
    if (parts.length > 0) return parts.join(' ');
  }
  if (error instanceof Error) return error.message;
  return truncate(String(error), 200);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
