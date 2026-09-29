import { describe, expect, it } from 'vitest';
import { loadConfig, MAX_WATCH_PRODUCTS, watchOnlyProducts } from './config.schema';

const load = (env: Record<string, string>) => loadConfig({ LOG_LEVEL: 'fatal', ...env });

describe('WATCH_PRODUCTS', () => {
  it('defaults to watching nothing extra', () => {
    const config = load({});
    expect(config.WATCH_PRODUCTS).toEqual([]);
    expect(watchOnlyProducts(config)).toEqual([]);
  });

  it('parses a list like PRODUCTS does', () => {
    const config = load({ WATCH_PRODUCTS: ' eth-usd, SOL-USD ,,' });
    expect(watchOnlyProducts(config)).toEqual(['ETH-USD', 'SOL-USD']);
  });

  it('drops duplicates and anything already traded, so no coin shows twice', () => {
    const config = load({
      PRODUCTS: 'BTC-USD,ETH-USD',
      WATCH_PRODUCTS: 'ETH-USD,SOL-USD,SOL-USD,BTC-USD',
    });
    expect(watchOnlyProducts(config)).toEqual(['SOL-USD']);
  });

  it(`refuses more than ${MAX_WATCH_PRODUCTS} watch-only products`, () => {
    const many = Array.from({ length: MAX_WATCH_PRODUCTS + 1 }, (_, i) => `C${i}-USD`).join(',');
    expect(() => load({ WATCH_PRODUCTS: many })).toThrow(/WATCH_PRODUCTS/);
  });

  it('counts only the watch-only ones against the limit', () => {
    const traded = Array.from({ length: 3 }, (_, i) => `T${i}-USD`);
    const watched = Array.from({ length: MAX_WATCH_PRODUCTS }, (_, i) => `W${i}-USD`);
    expect(() =>
      load({ PRODUCTS: traded.join(','), WATCH_PRODUCTS: [...traded, ...watched].join(',') }),
    ).not.toThrow();
  });
});
