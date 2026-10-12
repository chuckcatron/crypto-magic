import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { D } from '@crypto-magic/core';
import { ExchangeError } from '../types';
import { CoinbaseAdapter } from './coinbase-adapter';

const PRODUCT = {
  product_id: 'BTC-USD',
  price: '60000',
  base_name: 'Bitcoin',
  quote_name: 'US Dollar',
  base_currency_id: 'BTC',
  quote_currency_id: 'USD',
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

describe('CoinbaseAdapter request timeout', () => {
  let server: Server | undefined;
  const hung: ServerResponse[] = [];

  afterEach(async () => {
    for (const res of hung.splice(0)) res.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** A real HTTP server that never answers the first `hangFor` requests. */
  async function coinbaseThatHangs(
    hangFor: number,
  ): Promise<{ baseUrl: string; hits: () => number }> {
    let hits = 0;
    server = createServer((_req, res) => {
      hits++;
      if (hits <= hangFor) {
        hung.push(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(PRODUCT));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { baseUrl: `http://127.0.0.1:${port}`, hits: () => hits };
  }

  it('abandons a request that never answers, instead of waiting out the SDK default', async () => {
    const { baseUrl } = await coinbaseThatHangs(Infinity);
    const adapter = new CoinbaseAdapter({ baseUrl, requestTimeoutMs: 100, maxRetries: 0 });

    const started = Date.now();
    const error = await adapter.getProduct('BTC-USD').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExchangeError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reports a timeout as retryable, which is what makes a timed-out order ambiguous', async () => {
    const { baseUrl } = await coinbaseThatHangs(Infinity);
    const adapter = new CoinbaseAdapter({ baseUrl, requestTimeoutMs: 100, maxRetries: 0 });

    const error = await adapter.getProduct('BTC-USD').catch((e: unknown) => e);

    // The executor engages the kill switch precisely when retryable === true.
    expect((error as ExchangeError).retryable).toBe(true);
  });

  it('retries a read that timed out, and succeeds when the next attempt answers', async () => {
    const { baseUrl, hits } = await coinbaseThatHangs(1);
    const adapter = new CoinbaseAdapter({ baseUrl, requestTimeoutMs: 100, maxRetries: 1 });

    const spec = await adapter.getProduct('BTC-USD');

    expect(spec.productId).toBe('BTC-USD');
    expect(hits()).toBe(2);
  });
});

describe('CoinbaseAdapter key permissions', () => {
  it('maps the key_permissions response', async () => {
    const adapter = adapterWith({
      getApiKeyPermissions: async () => ({
        can_view: true,
        can_trade: true,
        can_transfer: false,
        portfolio_uuid: 'p-123',
        portfolio_type: 'CONSUMER',
      }),
    });
    await expect(adapter.getKeyPermissions()).resolves.toEqual({
      canView: true,
      canTrade: true,
      canTransfer: false,
      portfolioUuid: 'p-123',
      portfolioType: 'CONSUMER',
    });
  });

  it('needs credentials', async () => {
    await expect(new CoinbaseAdapter({}).getKeyPermissions()).rejects.toThrow(
      /requires Coinbase API credentials/,
    );
  });
});

describe('CoinbaseAdapter fee tier', () => {
  // Coinbase sends the volume as a string, though the SDK's type says number.
  const summary = (feeTier: Record<string, unknown> | undefined) => ({
    total_volume: '1234.5',
    total_fees: '0',
    fee_tier: feeTier,
    advanced_trade_only_volume: 0,
    advanced_trade_only_fees: 0,
    total_balance: '1000',
  });
  const INTRO = {
    pricing_tier: 'Intro 1',
    usd_from: '0',
    usd_to: '10000',
    taker_fee_rate: '0.009',
    maker_fee_rate: '0.005',
  };

  it('reads the spot tier from the transaction summary', async () => {
    const requests: unknown[] = [];
    const adapter = adapterWith({
      getTransactionSummary: async (params: unknown) => {
        requests.push(params);
        return summary(INTRO);
      },
    });

    const tier = await adapter.getFeeTier();

    expect(requests).toEqual([{ product_type: 'SPOT' }]);
    expect(tier.pricingTier).toBe('Intro 1');
    expect(tier.takerFeeRate.toString()).toBe('0.009');
    expect(tier.makerFeeRate.toString()).toBe('0.005');
    expect(tier.volume30dUsd.toNumber()).toBe(1234.5);
  });

  it('refuses a summary with no fee tier, or a rate that is not one', async () => {
    await expect(
      adapterWith({ getTransactionSummary: async () => summary(undefined) }).getFeeTier(),
    ).rejects.toThrow(/no fee tier/);
    for (const bad of ['', 'abc', '1.5', '-2']) {
      const adapter = adapterWith({
        getTransactionSummary: async () => summary({ ...INTRO, taker_fee_rate: bad }),
      });
      await expect(adapter.getFeeTier()).rejects.toThrow(/unusable taker fee rate/);
    }
  });

  it('accepts a maker rebate, which Coinbase reports as a negative rate', async () => {
    const adapter = adapterWith({
      getTransactionSummary: async () => summary({ ...INTRO, maker_fee_rate: '-0.00004' }),
    });
    await expect(adapter.getFeeTier()).resolves.toMatchObject({ pricingTier: 'Intro 1' });
    expect((await adapter.getFeeTier()).makerFeeRate.toString()).toBe('-0.00004');
  });

  it('needs credentials', async () => {
    await expect(new CoinbaseAdapter({}).getFeeTier()).rejects.toThrow(
      /requires Coinbase API credentials/,
    );
  });
});

describe('CoinbaseAdapter maker orders', () => {
  const request = {
    productId: 'BTC-USD',
    side: 'BUY' as const,
    baseSize: D('0.012345678'),
    limitPrice: D('60000.017'),
    expiresAt: Date.parse('2026-10-11T01:00:00.123Z'),
    clientOrderId: 'LB-BTCUSD-1-entry-maker',
  };
  const accepted = { success: true, success_response: { order_id: 'ord-1' } };
  const openOrder = {
    order: {
      order_id: 'ord-1',
      client_order_id: 'cbnodeLB-BTCUSD-1-entry-maker',
      product_id: 'BTC-USD',
      side: 'BUY',
      status: 'OPEN',
      filled_size: '0',
      average_filled_price: '0',
      total_fees: '0',
      created_time: '2026-10-11T00:00:01Z',
    },
  };

  it('sends a post-only GTD limit that Coinbase itself expires, rounded onto its own side', async () => {
    const sent: unknown[] = [];
    const adapter = adapterWith({
      getProduct: async () => PRODUCT,
      submitOrder: async (body: unknown) => {
        sent.push(body);
        return accepted;
      },
      getOrder: async () => openOrder,
    });

    const order = await adapter.submitMakerOrder(request);

    expect(sent).toEqual([
      {
        client_order_id: 'cbnodeLB-BTCUSD-1-entry-maker',
        product_id: 'BTC-USD',
        side: 'BUY',
        order_configuration: {
          limit_limit_gtd: {
            base_size: '0.01234567',
            // A buy rounds down, away from the ask.
            limit_price: '60000.01',
            end_time: '2026-10-11T01:00:00Z',
            post_only: true,
          },
        },
      },
    ]);
    expect(order.status).toBe('OPEN');
  });

  it('rounds a sell up, away from the bid', async () => {
    const sent: { order_configuration: { limit_limit_gtd: { limit_price: string } } }[] = [];
    const adapter = adapterWith({
      getProduct: async () => PRODUCT,
      submitOrder: async (body: unknown) => {
        sent.push(body as (typeof sent)[number]);
        return accepted;
      },
      getOrder: async () => openOrder,
    });
    await adapter.submitMakerOrder({ ...request, side: 'SELL' });
    expect(sent[0]!.order_configuration.limit_limit_gtd.limit_price).toBe('60000.02');
  });

  it('NEVER retries the placement, and marks a network failure ambiguous', async () => {
    let submits = 0;
    const adapter = adapterWith({
      getProduct: async () => PRODUCT,
      submitOrder: async () => {
        submits++;
        throw networkError('ECONNRESET');
      },
    });
    const error = await adapter.submitMakerOrder(request).catch((e: unknown) => e);
    expect(submits).toBe(1);
    expect((error as ExchangeError).retryable).toBe(true);
  });

  it('turns a refusal, such as post-only crossing, into a definite failure', async () => {
    const adapter = adapterWith({
      getProduct: async () => PRODUCT,
      submitOrder: async () => ({
        success: false,
        error_response: {
          new_order_failure_reason: 'INVALID_LIMIT_PRICE_POST_ONLY',
          message: 'Invalid limit price post only',
        },
      }),
    });
    const error = await adapter.submitMakerOrder(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExchangeError);
    expect((error as ExchangeError).retryable).toBe(false);
    expect((error as Error).message).toMatch(/INVALID_LIMIT_PRICE_POST_ONLY/);
  });

  it('reports a placed order as open even when reading it back fails', async () => {
    const adapter = adapterWith(
      {
        getProduct: async () => PRODUCT,
        submitOrder: async () => accepted,
        getOrder: async () => {
          throw Object.assign(new Error('bad gateway'), { status: 502 });
        },
      },
      0,
    );
    const order = await adapter.submitMakerOrder(request);
    expect(order.orderId).toBe('ord-1');
    expect(order.status).toBe('OPEN');
  });

  it('needs credentials', async () => {
    await expect(new CoinbaseAdapter({}).submitMakerOrder(request)).rejects.toThrow(
      /requires Coinbase API credentials/,
    );
  });
});

describe('CoinbaseAdapter best bid and ask', () => {
  const book = (bids: { price: string }[], asks: { price: string }[]) => ({
    pricebook: { product_id: 'BTC-USD', bids, asks, time: '2026-10-11T00:00:00Z' },
  });

  it('reads the top of the book', async () => {
    const adapter = adapterWith({
      getProductBook: async () => book([{ price: '60000.01' }], [{ price: '60000.02' }]),
    });
    const top = await adapter.getBestBidAsk('BTC-USD');
    expect(top.bid.toString()).toBe('60000.01');
    expect(top.ask.toString()).toBe('60000.02');
  });

  it('uses the public book without credentials', async () => {
    const adapter = new CoinbaseAdapter({});
    (adapter as unknown as { client: unknown }).client = {
      getPublicProductBook: async () => book([{ price: '1.5' }], [{ price: '1.6' }]),
    };
    expect((await adapter.getBestBidAsk('BTC-USD')).bid.toString()).toBe('1.5');
  });

  it('refuses an empty or crossed book rather than pricing an order off it', async () => {
    const empty = adapterWith({ getProductBook: async () => book([], [{ price: '1' }]) });
    await expect(empty.getBestBidAsk('BTC-USD')).rejects.toThrow(/no usable best bid/);
    const crossed = adapterWith({
      getProductBook: async () => book([{ price: '2' }], [{ price: '1' }]),
    });
    await expect(crossed.getBestBidAsk('BTC-USD')).rejects.toThrow(/crossed book/);
  });
});
