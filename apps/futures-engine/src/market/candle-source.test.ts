import { describe, expect, it } from 'vitest';
import { CoinbaseCandleSource } from './candle-source';

const candle = (t: number, close = 100) => ({
  start: String(t),
  open: '100',
  high: '101',
  low: '99',
  close: String(close),
  volume: '5',
});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CoinbaseCandleSource', () => {
  it('pages through a long range and returns closed bars ascending', async () => {
    const urls: string[] = [];
    const fake: typeof fetch = async (input) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      urls.push(url.toString());
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const candles = [];
      // Coinbase answers newest first.
      for (let t = end - 300; t >= start; t -= 300) candles.push(candle(t));
      return response(200, { candles });
    };
    const now = 1_000 * 300 + 10;
    const source = new CoinbaseCandleSource(
      fake,
      () => now,
      async () => {},
    );
    const bars = await source.fetch('BTC-USD', 'FIVE_MINUTE', 0, 1_000 * 300);

    expect(urls).toHaveLength(4);
    expect(bars).toHaveLength(1_000);
    expect(bars[0]!.t).toBe(0);
    expect(bars.at(-1)!.t).toBe(999 * 300);
    expect(bars.every((b, i) => i === 0 || b.t > bars[i - 1]!.t)).toBe(true);
  });

  it('never returns the bar that is still forming', async () => {
    const fake: typeof fetch = async () =>
      response(200, { candles: [candle(600), candle(300), candle(0)] });
    const source = new CoinbaseCandleSource(
      fake,
      () => 700,
      async () => {},
    );
    const bars = await source.fetch('BTC-USD', 'FIVE_MINUTE', 0, 900);
    expect(bars.map((b) => b.t)).toEqual([0, 300]);
  });

  it('retries a rate limit and a dropped connection, then succeeds', async () => {
    let calls = 0;
    const fake: typeof fetch = async () => {
      calls++;
      if (calls === 1) return response(429, {});
      if (calls === 2) throw new TypeError('fetch failed');
      return response(200, { candles: [candle(0)] });
    };
    const waits: number[] = [];
    const source = new CoinbaseCandleSource(
      fake,
      () => 10_000,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(await source.fetch('BTC-USD', 'FIVE_MINUTE', 0, 300)).toHaveLength(1);
    expect(waits).toEqual([1000, 2000]);
  });

  it('gives up on a client error at once, and on server errors after four tries', async () => {
    let calls = 0;
    const badRequest = new CoinbaseCandleSource(
      async () => {
        calls++;
        return response(400, {});
      },
      () => 10_000,
      async () => {},
    );
    await expect(badRequest.fetch('NOPE', 'ONE_DAY', 0, 86_400)).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);

    calls = 0;
    const down = new CoinbaseCandleSource(
      async () => {
        calls++;
        return response(503, {});
      },
      () => 10_000,
      async () => {},
    );
    await expect(down.fetch('BTC-USD', 'ONE_DAY', 0, 86_400)).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(4);
  });

  it('skips a malformed candle rather than trading on it', async () => {
    const fake: typeof fetch = async () =>
      response(200, { candles: [candle(300), { ...candle(0), high: '90' }] });
    const source = new CoinbaseCandleSource(
      fake,
      () => 10_000,
      async () => {},
    );
    expect((await source.fetch('BTC-USD', 'FIVE_MINUTE', 0, 600)).map((b) => b.t)).toEqual([300]);
  });
});
