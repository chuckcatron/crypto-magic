import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/config.schema';
import { FakeMarketData } from '../testing/fake-exchange';
import { DISPLAY_PRICE_TTL_MS, MarketDataService } from './market-data.service';

describe('MarketDataService.displayPrice', () => {
  let market: FakeMarketData;
  let service: MarketDataService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    market = new FakeMarketData();
    market.price = 84_000;
    service = new MarketDataService(
      market,
      loadConfig({ LOG_LEVEL: 'fatal' } as NodeJS.ProcessEnv),
    );
  });

  afterEach(() => vi.useRealTimers());

  it('returns the exchange price', async () => {
    await expect(service.displayPrice('BTC-USD')).resolves.toEqual({
      productId: 'BTC-USD',
      price: 84_000,
      fetchedAt: Date.now(),
      error: null,
    });
  });

  it('reuses a fresh price instead of calling the exchange again', async () => {
    const spy = vi.spyOn(market, 'getTicker');
    await service.displayPrice('BTC-USD');
    market.price = 90_000;
    vi.advanceTimersByTime(DISPLAY_PRICE_TTL_MS - 1);

    expect((await service.displayPrice('BTC-USD')).price).toBe(84_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the cached price is older than the TTL', async () => {
    await service.displayPrice('BTC-USD');
    market.price = 90_000;
    vi.advanceTimersByTime(DISPLAY_PRICE_TTL_MS);

    expect((await service.displayPrice('BTC-USD')).price).toBe(90_000);
  });

  it('shares one exchange call between concurrent callers', async () => {
    const spy = vi.spyOn(market, 'getTicker');
    await Promise.all([service.displayPrice('BTC-USD'), service.displayPrice('BTC-USD')]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good price and flags it stale when a refresh fails', async () => {
    await service.displayPrice('BTC-USD');
    const firstFetch = Date.now();
    vi.advanceTimersByTime(DISPLAY_PRICE_TTL_MS);
    vi.spyOn(market, 'getTicker').mockRejectedValue(new Error('coinbase unreachable'));

    await expect(service.displayPrice('BTC-USD')).resolves.toEqual({
      productId: 'BTC-USD',
      price: 84_000,
      fetchedAt: firstFetch,
      error: 'coinbase unreachable',
    });
  });

  it('retries on the next call after a failure rather than caching the error', async () => {
    const spy = vi.spyOn(market, 'getTicker').mockRejectedValueOnce(new Error('blip'));
    expect((await service.displayPrice('BTC-USD')).price).toBeNull();

    const recovered = await service.displayPrice('BTC-USD');
    expect(recovered).toMatchObject({ price: 84_000, error: null });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
