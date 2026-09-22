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
  it('debits notional plus fee and credits the base asset', async () => {
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
    expect(order.fee.toNumber()).toBeCloseTo(100.05 * 0.006, 8);
    expect((await balanceOf(adapter, 'BTC')).toNumber()).toBe(1);
    expect((await balanceOf(adapter, 'USD')).toNumber()).toBeCloseTo(
      1000 - 100.05 - 100.05 * 0.006,
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
  it('credits proceeds net of fee', async () => {
    const adapter = makeAdapter(1000);
    await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'BUY', baseSize: D(1), referencePrice: D(100), clientOrderId: 'b',
    });
    const usdAfterBuy = await balanceOf(adapter, 'USD');

    const sell = await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'SELL', baseSize: D(1), referencePrice: D(100), clientOrderId: 's',
    });

    // Sells slip down: 100 * (1 - 5bps) = 99.95
    expect(sell.averageFillPrice.toNumber()).toBeCloseTo(99.95, 8);
    expect((await balanceOf(adapter, 'BTC')).toNumber()).toBe(0);
    expect((await balanceOf(adapter, 'USD')).toNumber()).toBeCloseTo(
      usdAfterBuy.toNumber() + 99.95 - 99.95 * 0.006,
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
    await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'BUY', baseSize: D(1), referencePrice: D(100), clientOrderId: 'b',
    });
    await adapter.submitMarketOrder({
      productId: 'BTC-USD', side: 'SELL', baseSize: D(1), referencePrice: D(100), clientOrderId: 's',
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
    expect((await balanceOf(adapter, 'BTC')).toNumber()).toBe(1); // not 2
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
