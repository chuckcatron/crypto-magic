import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.schema';
import type { MarketDataService } from '../market-data/market-data.service';
import { ApiController } from './api.controller';

/** The controller with only what /prices uses; everything else is never reached. */
function controllerFor(env: Record<string, string>, requested: string[]) {
  const config = loadConfig({ LOG_LEVEL: 'fatal', ...env });
  const marketData = {
    displayPrice: (productId: string) => {
      requested.push(productId);
      return Promise.resolve({ productId, price: 10, fetchedAt: 1, error: null });
    },
  } as unknown as MarketDataService;
  const unused = null as never;
  return new ApiController(
    config,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    marketData,
  );
}

describe('GET /prices', () => {
  it('lists traded products first, then watch-only ones, flagged', async () => {
    const requested: string[] = [];
    const api = controllerFor(
      { PRODUCTS: 'BTC-USD', WATCH_PRODUCTS: 'ETH-USD,BTC-USD,SOL-USD' },
      requested,
    );

    const prices = await api.prices();

    expect(prices.map((p) => [p.productId, p.watchOnly])).toEqual([
      ['BTC-USD', false],
      ['ETH-USD', true],
      ['SOL-USD', true],
    ]);
    // BTC is both traded and watched: fetched once, not twice.
    expect(requested).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD']);
    expect(prices[1]!.price).toBe('10');
  });
});
