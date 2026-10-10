import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D, type Candle, type ProductSpec, type Ticker } from '@crypto-magic/core';
import type { Balance, BestBidAsk, ExchangeAdapter, OrderResult } from '../types';
import { PaperAdapter } from './paper-adapter';

const PRODUCT: ProductSpec = {
  productId: 'BTC-USD',
  baseCurrency: 'BTC',
  quoteCurrency: 'USD',
  baseIncrement: '0.00000001',
  quoteIncrement: '0.01',
  minMarketFunds: '1',
  tradingDisabled: false,
};

const MINUTE = 60_000;
const PLACED_AT = Date.parse('2026-10-11T00:00:05Z');
const HOUR = 60 * MINUTE;

/** Market data with a book and one-minute bars; the bars are set per test. */
class Market implements ExchangeAdapter {
  readonly name = 'market';
  readonly isLive = false;
  price = 100;
  book: BestBidAsk = { bid: D('99.99'), ask: D('100.01') };
  minuteBars: Candle[] = [];

  async getProduct(): Promise<ProductSpec> {
    return PRODUCT;
  }
  async getCandles(args: { granularity: string }): Promise<Candle[]> {
    return args.granularity === 'ONE_MINUTE' ? this.minuteBars : [];
  }
  async getTicker(productId: string): Promise<Ticker> {
    return { productId, price: this.price, timestamp: Date.now() };
  }
  async getBestBidAsk(): Promise<BestBidAsk> {
    return this.book;
  }
  async getBalances(): Promise<Balance[]> {
    return [];
  }
  async submitMarketOrder(): Promise<OrderResult> {
    throw new Error('market data does not execute');
  }
  async getOrder(): Promise<OrderResult | null> {
    return null;
  }
  async listOpenOrders(): Promise<OrderResult[]> {
    return [];
  }
  async cancelOrders(): Promise<void> {}
}

/** A closed one-minute bar opening `minutesAfter` whole minutes after the order's minute. */
function bar(minutesAfter: number, low: number, high: number): Candle {
  const opened = Math.floor(PLACED_AT / MINUTE) * MINUTE + minutesAfter * MINUTE;
  return {
    productId: 'BTC-USD',
    granularity: 'ONE_MINUTE',
    openTime: opened / 1000,
    open: (low + high) / 2,
    high,
    low,
    close: (low + high) / 2,
    volume: 1,
  };
}

function setup(balances: Record<string, number> = { USD: 1000 }) {
  const market = new Market();
  const saved: Record<string, string>[] = [];
  const adapter = new PaperAdapter({
    marketData: market,
    initialBalances: balances,
    takerBps: 60,
    makerBps: 40,
    slippageBps: 5,
    onBalancesChanged: (b) => saved.push(b),
  });
  const balance = async (currency: string) =>
    (await adapter.getBalances()).find((b) => b.currency === currency) ?? {
      available: D(0),
      hold: D(0),
    };
  const buy = (limit = '99.99', clientOrderId = 'mk-buy') =>
    adapter.submitMakerOrder({
      productId: 'BTC-USD',
      side: 'BUY',
      baseSize: D(1),
      limitPrice: D(limit),
      expiresAt: PLACED_AT + HOUR,
      clientOrderId,
    });
  return { market, adapter, saved, balance, buy };
}

describe('PaperAdapter maker orders', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PLACED_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rests a post-only buy and holds its cost plus the maker fee, like Coinbase', async () => {
    const { buy, balance, saved } = setup();
    const order = await buy();

    expect(order.status).toBe('OPEN');
    const usd = await balance('USD');
    const held = 99.99 * 1.004;
    expect(usd.hold.toNumber()).toBeCloseTo(held, 8);
    expect(usd.available.toNumber()).toBeCloseTo(1000 - held, 8);
    // Nothing has changed hands yet.
    expect(saved).toHaveLength(0);
  });

  it('fills at its limit, paying the maker fee, once a later bar trades below it', async () => {
    const { market, adapter, buy, balance } = setup();
    const order = await buy();
    market.minuteBars = [bar(1, 99.98, 100.02)];
    vi.setSystemTime(PLACED_AT + 3 * MINUTE);

    const filled = (await adapter.getOrder(order.orderId))!;

    expect(filled.status).toBe('FILLED');
    expect(filled.filledSize.toNumber()).toBe(1);
    expect(filled.averageFillPrice.toNumber()).toBe(99.99);
    expect(filled.fee.toNumber()).toBeCloseTo(99.99 * 0.004, 10);
    expect((await balance('BTC')).available.toNumber()).toBe(1);
    const usd = await balance('USD');
    expect(usd.hold.toNumber()).toBe(0);
    expect(usd.available.toNumber()).toBeCloseTo(1000 - 99.99 * 1.004, 8);
  });

  it('does not fill when the price only touches the limit: it may be last in the queue', async () => {
    const { market, adapter, buy } = setup();
    const order = await buy();
    market.minuteBars = [bar(1, 99.99, 100.02)];
    vi.setSystemTime(PLACED_AT + 3 * MINUTE);

    expect((await adapter.getOrder(order.orderId))!.status).toBe('OPEN');
  });

  it('ignores a bar that began before the order did, or has not closed yet', async () => {
    const { market, adapter, buy } = setup();
    const order = await buy();
    // The order's own part-minute, and a bar still forming at "now".
    market.minuteBars = [bar(0, 99, 101), bar(2, 99, 101)];
    vi.setSystemTime(PLACED_AT + 2 * MINUTE + 30_000);

    expect((await adapter.getOrder(order.orderId))!.status).toBe('OPEN');
  });

  it('expires unfilled at its deadline and gives back the hold', async () => {
    const { adapter, buy, balance } = setup();
    const order = await buy();
    vi.setSystemTime(PLACED_AT + HOUR);

    const expired = (await adapter.getOrder(order.orderId))!;

    expect(expired.status).toBe('EXPIRED');
    expect(expired.filledSize.toNumber()).toBe(0);
    const usd = await balance('USD');
    expect(usd.hold.toNumber()).toBe(0);
    expect(usd.available.toNumber()).toBe(1000);
  });

  it('does not count a trade after the deadline', async () => {
    const { market, adapter, buy } = setup();
    const order = await buy();
    market.minuteBars = [bar(61, 90, 100)];
    vi.setSystemTime(PLACED_AT + 2 * HOUR);

    expect((await adapter.getOrder(order.orderId))!.status).toBe('EXPIRED');
  });

  it('refuses a buy at or above the ask, and a sell at or below the bid', async () => {
    const { adapter, buy } = setup({ USD: 1000, BTC: 1 });
    await expect(buy('100.01')).rejects.toThrow(/would take liquidity/);
    await expect(
      adapter.submitMakerOrder({
        productId: 'BTC-USD',
        side: 'SELL',
        baseSize: D(1),
        limitPrice: D('99.99'),
        expiresAt: PLACED_AT + HOUR,
        clientOrderId: 'mk-sell',
      }),
    ).rejects.toThrow(/would take liquidity/);
  });

  it('rests a sell on its coins, and fills it when a bar trades above the limit', async () => {
    const { market, adapter, balance } = setup({ USD: 0, BTC: 1 });
    const order = await adapter.submitMakerOrder({
      productId: 'BTC-USD',
      side: 'SELL',
      baseSize: D(1),
      limitPrice: D('100.01'),
      expiresAt: PLACED_AT + HOUR,
      clientOrderId: 'mk-sell',
    });
    expect((await balance('BTC')).hold.toNumber()).toBe(1);
    expect((await balance('BTC')).available.toNumber()).toBe(0);

    market.minuteBars = [bar(5, 99.9, 100.02)];
    vi.setSystemTime(PLACED_AT + 10 * MINUTE);
    const filled = (await adapter.getOrder(order.orderId))!;

    expect(filled.status).toBe('FILLED');
    expect((await balance('BTC')).available.toNumber()).toBe(0);
    expect((await balance('USD')).available.toNumber()).toBeCloseTo(100.01 * 0.996, 8);
  });

  it('cancels, giving back the hold, unless it had already filled', async () => {
    const { market, adapter, buy, balance } = setup();
    const unfilled = await buy('99.99', 'a');
    await adapter.cancelOrders([unfilled.orderId]);
    expect((await adapter.getOrder(unfilled.orderId))!.status).toBe('CANCELLED');
    expect((await balance('USD')).available.toNumber()).toBe(1000);

    const filledFirst = await buy('99.99', 'b');
    market.minuteBars = [bar(1, 99.5, 100)];
    vi.setSystemTime(PLACED_AT + 3 * MINUTE);
    await adapter.cancelOrders([filledFirst.orderId]);
    expect((await adapter.getOrder(filledFirst.orderId))!.status).toBe('FILLED');
  });

  it('refuses an order the free balance cannot cover', async () => {
    const { buy } = setup({ USD: 50 });
    await expect(buy()).rejects.toThrow(/free, needs/);
  });

  it('returns the original order for a repeated client order id', async () => {
    const { buy, balance } = setup();
    const first = await buy();
    const second = await buy();
    expect(second.orderId).toBe(first.orderId);
    expect((await balance('USD')).hold.toNumber()).toBeCloseTo(99.99 * 1.004, 8);
  });

  it('lists resting orders as open', async () => {
    const { adapter, buy } = setup();
    const order = await buy();
    expect((await adapter.listOpenOrders(['BTC-USD'])).map((o) => o.orderId)).toEqual([
      order.orderId,
    ]);
    expect(await adapter.listOpenOrders(['ETH-USD'])).toEqual([]);
  });

  it('prices on the ticker, both sides, when the market data has no book', async () => {
    const tickerOnly: ExchangeAdapter = {
      name: 'ticker-only',
      isLive: false,
      getProduct: async () => PRODUCT,
      getCandles: async () => [],
      getTicker: async (productId) => ({ productId, price: 100, timestamp: Date.now() }),
      getBalances: async () => [],
      submitMarketOrder: async () => {
        throw new Error('market data does not execute');
      },
      getOrder: async () => null,
      listOpenOrders: async () => [],
      cancelOrders: async () => {},
    };
    const adapter = new PaperAdapter({ marketData: tickerOnly, initialBalances: { USD: 1000 } });
    const book = await adapter.getBestBidAsk('BTC-USD');
    expect(book.bid.toNumber()).toBe(100);
    expect(book.ask.toNumber()).toBe(100);
  });
});
