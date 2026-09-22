import { Inject, Injectable } from '@nestjs/common';
import {
  GRANULARITY_SECONDS,
  type Candle,
  type ProductSpec,
  type Ticker,
} from '@crypto-magic/core';
import type { ExchangeAdapter } from '@crypto-magic/exchange';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { childLogger } from '../common/logger';

/**
 * Candle and ticker access with a small in-memory cache.
 *
 * Tracks the age of the newest bar it has seen. The risk engine halts entries
 * when that age exceeds the configured maximum, because a strategy reasoning
 * over a stale price is a strategy trading a market that no longer exists.
 */
@Injectable()
export class MarketDataService {
  private readonly log = childLogger('market-data');
  private readonly candleCache = new Map<string, Candle[]>();
  private newestBarCloseMs = 0;

  constructor(
    @Inject(EXCHANGE) private readonly exchange: ExchangeAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get marketDataAgeSeconds(): number {
    if (this.newestBarCloseMs === 0) return Number.POSITIVE_INFINITY;
    return (Date.now() - this.newestBarCloseMs) / 1000;
  }

  /**
   * Staleness budget in seconds, derived from the bar interval.
   *
   * The newest closed bar is always up to one interval old by definition, so
   * the tolerance has to be expressed in bars or an hourly strategy would look
   * permanently stale.
   */
  get maxMarketDataAgeSeconds(): number {
    return this.config.MAX_MARKET_DATA_AGE_BARS * GRANULARITY_SECONDS[this.config.GRANULARITY];
  }

  getProduct(productId: string): Promise<ProductSpec> {
    return this.exchange.getProduct(productId);
  }

  getTicker(productId: string): Promise<Ticker> {
    return this.exchange.getTicker(productId);
  }

  /**
   * Fetch at least `minBars` closed candles, ending at the most recent close.
   *
   * Over-fetches by 25% so a few missing buckets — Coinbase omits buckets with
   * no trades — still leave enough history to warm the indicators.
   */
  async getRecentCandles(productId: string, minBars: number): Promise<Candle[]> {
    const granularity = this.config.GRANULARITY;
    const step = GRANULARITY_SECONDS[granularity];
    const now = Math.floor(Date.now() / 1000);
    const barsToFetch = Math.ceil(minBars * 1.25) + 2;

    const candles = await this.exchange.getCandles({
      productId,
      granularity,
      start: now - barsToFetch * step,
      end: now,
    });

    if (candles.length > 0) {
      const newest = candles.at(-1)!;
      this.newestBarCloseMs = (newest.openTime + step) * 1000;
    }

    if (candles.length < minBars) {
      this.log.warn(
        { productId, got: candles.length, need: minBars },
        'not enough history to warm up indicators yet',
      );
    }

    this.candleCache.set(productId, candles);
    return candles;
  }

  /** Last fetched candles, without hitting the network. */
  cached(productId: string): Candle[] {
    return this.candleCache.get(productId) ?? [];
  }
}
