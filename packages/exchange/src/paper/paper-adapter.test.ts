import { describe, expect, it } from 'vitest';
import { D, type Candle, type Granularity, type ProductSpec, type Ticker } from '@crypto-magic/core';
import type { Balance, ExchangeAdapter, OrderResult } from '../types';
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

class StubMarketData implements ExchangeAdapter {
  readonly name = 'stub';
  readonly isLive = false;
  price = 100;

  async getProduct(): Promise<ProductSpec> {
    return PRODUCT;
  }
  async getCandles(): Promise<Candle[]> {
    return [];
  }
  async getTicker(productId: string): Promise<Ticker> {
    return { productId, price: this.price, timestamp: Date.now() };
  }
  async getBalances(): Promise<Balance[]> {
    return [];
  }
  async submitMarketOrder(): Promise<OrderResult> {
    throw new Error('stub does not execute');
  }
  async getOrder(): Promise<OrderResult | null> {
    return null;
  }
  async listOpenOrders(): Promise<OrderResult[]> {
    return [];
  }
  async cancelOrders(): Promise<void> {}
}

const makeAdapter = (usd = 1000) =>
  new PaperAdapter({
    marketData: new StubMarketData(),
    initialBalances: { USD: usd },
    takerBps: 60,
    slippageBps: 5,
  });

const balanceOf = async (adapter: PaperAdapter, currency: string) =>
  (await adapter.getBalances()).find((b) => b.currency === currency)?.available ?? D(0);

describe('PaperAdapter buys', () => {
  it('spends the requested QUOTE amount and receives fewer coins when price slips up', async () => {
    const adapter = makeAdapter(1000);
    const order = await adapter.submitMarketOrder({
      productId: 'BTC-USD',
      side: 'BUY',
      baseSize: D(1),
      referencePrice: D(100),
      clientOrderId: 'buy-1',
    });

    expect(order.status).toBe('FILLED');
    // Buys slip up: 100 * (1 + 5bps) = 100.05
    expect(order.averageFillPrice.toNumber()).toBeCloseTo(100.05, 8);

    // A market BUY is sized in quote currency, exactly as Coinbase executes it.
    // The caller asked to spend 1 * 100 = $100, so $100 is what is spent — and
    // the slipped price buys slightly under 1 coin rather than a full coin at a
    // higher cost.
    const spent = order.filledSize.mul(order.averageFillPrice);
    expect(spent.toNumber()).toBeLessThanOrEqual(100);
    expect(spent.toNumber()).toBeCloseTo(100, 4);
    expect(order.filledSize.toNumber()).toBeLessThan(1);
    expect(order.filledSize.toNumber()).toBeCloseTo(100 / 100.05, 6);
  });

  it('never spends more quote than asked, which is what makes a notional cap hard', async () => {
    const market = new StubMarketData();
    const adapter = new PaperAdapter({
      marketData: market,
      initialBalances: { USD: 10_000 },
      takerBps: 0,
      slippageBps: 200, // a brutal 2% adverse move
    });

    const order = await adapter.submitMarketOrder({
      productId: 'BTC-USD',
      side: 'BUY',
      baseSize: D(10),
      referencePrice: D(100), // asking to spend $1000
      clientOrderId: 'cap',
    });

    expect(order.filledSize.mul(order.averageFillPrice).toNumber()).toBeLessThanOrEqual(1000);
  });

  it('debits the fee on top of the quote spend', async () => {
    const adapter = makeAdapter(1000);
    const order = await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'BUY', baseSize: D(1), referencePrice: D(100), clientOrderId: 'fee',
    });
    const spent = order.filledSize.mul(order.averageFillPrice);
    expect(order.fee.toNumber()).toBeCloseTo(spent.mul(0.006).toNumber(), 8);
    expect((await balanceOf(adapter, 'USD')).toNumber()).toBeCloseTo(
      1000 - spent.toNumber() - order.fee.toNumber(),
      8,
    );
  });

  it('refuses a buy the paper account cannot afford', async () => {
    const adapter = makeAdapter(50);
    await expect(
      adapter.submitMarketOrder({
        productId: 'BTC-USD',
        side: 'BUY',
        baseSize: D(1),
        referencePrice: D(100),
        clientOrderId: 'buy-2',
      }),
    ).rejects.toThrow(/needs/);
  });
});

describe('PaperAdapter sells', () => {
  it('is sized in BASE currency and credits proceeds net of fee', async () => {
    const adapter = makeAdapter(1000);
    const buy = await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'BUY', baseSize: D(1), referencePrice: D(100), clientOrderId: 'b',
    });
    const usdAfterBuy = await balanceOf(adapter, 'USD');

    const sell = await adapter.submitMarketOrder({
      productId: 'BTC-USD',
      side: 'SELL',
      baseSize: buy.filledSize,
      referencePrice: D(100),
      clientOrderId: 's',
    });

    // Sells slip down: 100 * (1 - 5bps) = 99.95, and sell the exact base size.
    expect(sell.averageFillPrice.toNumber()).toBeCloseTo(99.95, 8);
    expect(sell.filledSize.toNumber()).toBe(buy.filledSize.toNumber());
    expect((await balanceOf(adapter, 'BTC')).toNumber()).toBe(0);

    const proceeds = sell.filledSize.mul(sell.averageFillPrice);
    expect((await balanceOf(adapter, 'USD')).toNumber()).toBeCloseTo(
      usdAfterBuy.plus(proceeds).minus(sell.fee).toNumber(),
      8,
    );
  });

  it('refuses to sell more base than it holds', async () => {
    const adapter = makeAdapter(1000);
    await expect(
      adapter.submitMarketOrder({
        productId: 'BTC-USD', side: 'SELL', baseSize: D(1), referencePrice: D(100), clientOrderId: 's2',
      }),
    ).rejects.toThrow(/holds/);
  });
});

describe('PaperAdapter round trip', () => {
  it('loses money at an unchanged price, because fees and slippage are real', async () => {
    const adapter = makeAdapter(1000);
    const buy = await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'BUY', baseSize: D(1), referencePrice: D(100), clientOrderId: 'b',
    });
    await adapter.submitMarketOrder({
      productId: 'BTC-USD',
      side: 'SELL',
      baseSize: buy.filledSize,
      referencePrice: D(100),
      clientOrderId: 's',
    });
    expect((await balanceOf(adapter, 'USD')).toNumber()).toBeLessThan(1000);
  });
});

describe('PaperAdapter idempotency', () => {
  it('returns the original order instead of filling a repeated client order id twice', async () => {
    const adapter = makeAdapter(1000);
    const first = await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'BUY', baseSize: D(1), referencePrice: D(100), clientOrderId: 'dup',
    });
    const second = await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'BUY', baseSize: D(1), referencePrice: D(100), clientOrderId: 'dup',
    });

    expect(second.orderId).toBe(first.orderId);
    // One fill, not two.
    expect((await balanceOf(adapter, 'BTC')).toNumber()).toBe(first.filledSize.toNumber());
  });
});

describe('PaperAdapter safety surface', () => {
  it('reports itself as not live so the engine can log the distinction', () => {
    expect(makeAdapter().isLive).toBe(false);
  });

  it('rejects an order that rounds away to nothing', async () => {
    const adapter = makeAdapter(1000);
    await expect(
      adapter.submitMarketOrder({
        productId: 'BTC-USD',
        side: 'BUY',
        baseSize: D('0.000000001'), // below the 1e-8 base increment
        referencePrice: D(100),
        clientOrderId: 'dust',
      }),
    ).rejects.toThrow(/rounds to zero/);
  });
});

describe('PaperAdapter persistence', () => {
  it('reports every balance after each fill, and a new adapter restores from it exactly', async () => {
    const saved: Record<string, string>[] = [];
    const market = new StubMarketData();
    const adapter = new PaperAdapter({
      marketData: market,
      initialBalances: { USD: 1000 },
      onBalancesChanged: (b) => saved.push(b),
    });

    await adapter.submitMarketOrder({
      productId: 'BTC-USD',
      side: 'BUY',
      baseSize: D('2'),
      referencePrice: D(100),
      clientOrderId: 'persist-1',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(adapter.balanceSnapshot());
    // Decimal strings, not floats: JSON must round-trip without drift.
    expect(Object.values(saved[0]!).every((v) => typeof v === 'string')).toBe(true);

    // "Restart": a fresh adapter seeded from what was saved.
    const restored = new PaperAdapter({
      marketData: market,
      initialBalances: JSON.parse(JSON.stringify(saved[0])),
    });
    expect(await restored.getBalances()).toEqual(await adapter.getBalances());
  });

  it('does not report when an order is rejected', async () => {
    const saved: Record<string, string>[] = [];
    const adapter = new PaperAdapter({
      marketData: new StubMarketData(),
      initialBalances: { USD: 10 },
      onBalancesChanged: (b) => saved.push(b),
    });

    await expect(
      adapter.submitMarketOrder({
        productId: 'BTC-USD',
        side: 'BUY',
        baseSize: D('5'),
        referencePrice: D(100),
        clientOrderId: 'too-big',
      }),
    ).rejects.toThrow(/paper account has/);
    expect(saved).toHaveLength(0);
  });
});
