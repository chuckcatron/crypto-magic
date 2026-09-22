import {
  D,
  GRANULARITY_SECONDS,
  type Candle,
  type Granularity,
  type ProductSpec,
  type Ticker,
} from '@crypto-magic/core';
import { crossedAbove, ema } from '@crypto-magic/core';
import type { Balance, ExchangeAdapter, OrderResult } from '@crypto-magic/exchange';

export const FAKE_PRODUCT: ProductSpec = {
  productId: 'BTC-USD',
  baseCurrency: 'BTC',
  quoteCurrency: 'USD',
  baseIncrement: '0.00000001',
  quoteIncrement: '0.01',
  minMarketFunds: '1',
  tradingDisabled: false,
};

/**
 * Market data source for integration tests: serves a fixed candle series and a
 * settable ticker. It cannot execute, which is the point — orders go through a
 * real PaperAdapter wrapped around this.
 */
export class FakeMarketData implements ExchangeAdapter {
  readonly name = 'fake-market-data';
  readonly isLive = false;

  candles: Candle[] = [];
  price = 100;

  async getProduct(): Promise<ProductSpec> {
    return FAKE_PRODUCT;
  }
  async getCandles(): Promise<Candle[]> {
    return this.candles;
  }
  async getTicker(productId: string): Promise<Ticker> {
    return { productId, price: this.price, timestamp: Date.now() };
  }
  async getBalances(): Promise<Balance[]> {
    return [];
  }
  async submitMarketOrder(): Promise<OrderResult> {
    throw new Error('FakeMarketData cannot execute orders');
  }
  async getOrder(): Promise<OrderResult | null> {
    return null;
  }
  async listOpenOrders(): Promise<OrderResult[]> {
    return [];
  }
  async cancelOrders(): Promise<void> {}
}

/**
 * Build candles whose newest bar closed a moment ago, so the engine's staleness
 * check sees fresh data. Tests that pin timestamps to a fixed date would trip
 * the stale-market-data halt instead of exercising the strategy.
 */
export function candlesEndingNow(
  closes: number[],
  granularity: Granularity = 'ONE_HOUR',
  rangePct = 0.005,
): Candle[] {
  const step = GRANULARITY_SECONDS[granularity];
  const lastClose = Math.floor(Date.now() / 1000 / step) * step;
  const firstOpen = lastClose - closes.length * step;

  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    const band = close * rangePct;
    return {
      productId: 'BTC-USD',
      granularity,
      openTime: firstOpen + i * step,
      open,
      high: Math.max(open, close) + band,
      low: Math.min(open, close) - band,
      close,
      volume: 100,
    };
  });
}

export const asDecimal = D;

/**
 * A quiet leg followed by a rally just long enough that the fast/slow EMA cross
 * lands on the FINAL bar.
 *
 * The engine evaluates only the newest closed bar, exactly as it does live. A
 * fixture whose cross happens three bars from the end therefore produces no
 * signal at all, which looks like a broken strategy rather than a mis-built
 * fixture. Growing the rally until the cross is last — and throwing if it never
 * is — keeps the test honest about what it is exercising.
 */
export function seriesCrossingUpOnLastBar(
  quietBars = 120,
  opts: { start?: number; perBarGain?: number; fastPeriod?: number; slowPeriod?: number } = {},
): number[] {
  const start = opts.start ?? 100;
  const perBarGain = opts.perBarGain ?? 0.008;
  const fastPeriod = opts.fastPeriod ?? 12;
  const slowPeriod = opts.slowPeriod ?? 26;

  const span = Math.max(1, quietBars - 1);
  const quiet = Array.from(
    { length: quietBars },
    (_, i) => start * (1 - (0.02 * i) / span) + (i % 2 === 0 ? 0.1 : -0.1),
  );
  const base = quiet.at(-1)!;

  for (let rallyBars = 1; rallyBars <= 60; rallyBars++) {
    const series = [
      ...quiet,
      ...Array.from({ length: rallyBars }, (_, i) => base * (1 + perBarGain) ** (i + 1)),
    ];
    const last = series.length - 1;
    if (crossedAbove(ema(series, fastPeriod), ema(series, slowPeriod), last)) return series;
  }
  throw new Error('could not build a series whose EMA cross lands on the last bar');
}
