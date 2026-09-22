import { describe, expect, it } from 'vitest';
import { D } from '@crypto-magic/core';
import { ExchangeError } from '../types';
import { CoinbaseAdapter } from './coinbase-adapter';

const PRODUCT = {
  product_id: 'BTC-USD',
  price: '60000',
  base_name: 'BTC',
  quote_name: 'USD',
  base_increment: '0.00000001',
  quote_increment: '0.01',
  quote_min_size: '1',
  trading_disabled: false,
};

const networkError = (code: string) => Object.assign(new Error(`socket ${code}`), { code });

/**
 * Build an authenticated adapter whose SDK client is replaced by a stub, so we
 * can count exactly how many times each endpoint is hit.
 */
function adapterWith(stub: Record<string, (...args: unknown[]) => unknown>, maxRetries = 2) {
  const adapter = new CoinbaseAdapter({
    apiKey: 'organizations/test/apiKeys/test',
    apiSecret: '-----BEGIN EC PRIVATE KEY-----\nnot-a-real-key\n-----END EC PRIVATE KEY-----\n',
    maxRetries,
  });
  (adapter as unknown as { client: unknown }).client = stub;
  return adapter;
}

describe('CoinbaseAdapter retry policy', () => {
  it('NEVER retries a market order submission, even on a retryable network error', async () => {
    let submits = 0;
    const adapter = adapterWith({
      getProduct: async () => PRODUCT,
      submitOrder: async () => {
        submits++;
        // The ambiguous case: the connection died after Coinbase may have
        // accepted the order. A retry here is how one position becomes two.
        throw networkError('ECONNRESET');
      },
    });

    const attempt = adapter.submitMarketOrder({
      productId: 'BTC-USD',
      side: 'BUY',
      baseSize: D('0.0001'),
      referencePrice: D('60000'),
      clientOrderId: 'intent-1',
    });

    await expect(attempt).rejects.toBeInstanceOf(ExchangeError);
    expect(submits).toBe(1);
  });

  it('marks that failure retryable, so the executor treats it as ambiguous and halts', async () => {
    const adapter = adapterWith({
      getProduct: async () => PRODUCT,
      submitOrder: async () => {
        throw networkError('ETIMEDOUT');
      },
    });

    const error = await adapter
      .submitMarketOrder({
        productId: 'BTC-USD',
        side: 'BUY',
        baseSize: D('0.0001'),
        referencePrice: D('60000'),
        clientOrderId: 'intent-2',
      })
      .catch((e: unknown) => e);

    // The executor engages the kill switch precisely when retryable === true.
    expect((error as ExchangeError).retryable).toBe(true);
  });

  it('NEVER retries a protective stop submission', async () => {
    let submits = 0;
    const adapter = adapterWith({
      getProduct: async () => PRODUCT,
      submitOrder: async () => {
        submits++;
        throw Object.assign(new Error('bad gateway'), { status: 502 });
      },
    });

    await expect(
      adapter.submitProtectiveStop({
        productId: 'BTC-USD',
        baseSize: D('0.0001'),
        stopPrice: D('58000'),
        limitPrice: D('57700'),
        clientOrderId: 'stop-1',
      }),
    ).rejects.toBeInstanceOf(ExchangeError);
    expect(submits).toBe(1);
  });

  it('DOES retry a read, where repeating the request is harmless', async () => {
    let calls = 0;
    const adapter = adapterWith(
      {
        getProduct: async () => {
          calls++;
          if (calls === 1) throw networkError('ECONNRESET');
          return PRODUCT;
        },
      },
      1,
    );

    const spec = await adapter.getProduct('BTC-USD');
    expect(spec.productId).toBe('BTC-USD');
    expect(calls).toBe(2);
  });

  it('does not retry a read on a non-transient error', async () => {
    let calls = 0;
    const adapter = adapterWith({
      getProduct: async () => {
        calls++;
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      },
    });

    await expect(adapter.getProduct('BTC-USD')).rejects.toBeInstanceOf(ExchangeError);
    expect(calls).toBe(1);
  });
});

describe('CoinbaseAdapter without credentials', () => {
  it('cannot place an order at all', async () => {
    const adapter = new CoinbaseAdapter({});
    expect(adapter.isLive).toBe(false);
    await expect(
      adapter.submitMarketOrder({
        productId: 'BTC-USD',
        side: 'BUY',
        baseSize: D('0.0001'),
        referencePrice: D('60000'),
        clientOrderId: 'nope',
      }),
    ).rejects.toThrow(/requires Coinbase API credentials/);
  });
});
