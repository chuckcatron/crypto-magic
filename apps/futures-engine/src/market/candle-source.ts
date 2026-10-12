import type { Bar } from '@crypto-magic/futures';

export type CandleGranularity = 'FIVE_MINUTE' | 'ONE_DAY';

export const GRANULARITY_SECONDS: Record<CandleGranularity, number> = {
  FIVE_MINUTE: 300,
  ONE_DAY: 86_400,
};

/** Where closed bars come from. Swapped for a fake in tests. */
export interface CandleSource {
  /** Closed bars opening in [start, end), ascending. Never the bar still forming. */
  fetch(
    productId: string,
    granularity: CandleGranularity,
    start: number,
    end: number,
  ): Promise<Bar[]>;
}

export const CANDLE_SOURCE = Symbol('CANDLE_SOURCE');

/** The endpoint returns at most 350 candles per request. */
const PAGE = 300;
const MAX_ATTEMPTS = 4;

interface RawCandle {
  readonly start: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

/**
 * Coinbase's public market-data candles: no key, nothing that can trade.
 * Reads are retried with backoff on rate limits, server errors and dropped
 * connections; anything else fails the call, and the engine tries again on
 * its next tick.
 */
export class CoinbaseCandleSource implements CandleSource {
  constructor(
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly baseUrl = 'https://api.coinbase.com/api/v3/brokerage/market/products',
  ) {}

  async fetch(
    productId: string,
    granularity: CandleGranularity,
    start: number,
    end: number,
  ): Promise<Bar[]> {
    const step = GRANULARITY_SECONDS[granularity];
    const closedBy = this.now();
    const bars = new Map<number, Bar>();
    for (let from = start; from < end; from += PAGE * step) {
      const to = Math.min(end, from + PAGE * step);
      for (const candle of await this.page(productId, granularity, from, to)) {
        const bar = toBar(candle);
        if (!bar || bar.t < start || bar.t >= end || bar.t + step > closedBy) continue;
        bars.set(bar.t, bar);
      }
    }
    return [...bars.values()].sort((a, b) => a.t - b.t);
  }

  private async page(
    productId: string,
    granularity: CandleGranularity,
    start: number,
    end: number,
  ): Promise<RawCandle[]> {
    const url =
      `${this.baseUrl}/${encodeURIComponent(productId)}/candles` +
      `?granularity=${granularity}&start=${start}&end=${end}&limit=${PAGE}`;
    let lastFailure = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let status: number | undefined;
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
        status = response.status;
        if (response.ok) {
          const body = (await response.json()) as { candles?: RawCandle[] };
          return body.candles ?? [];
        }
        lastFailure = `HTTP ${status}`;
        if (status !== 429 && status < 500) break;
      } catch (error) {
        // A timeout, reset connection or truncated body: a read, so safe to retry.
        lastFailure = error instanceof Error ? error.message : String(error);
      }
      if (attempt < MAX_ATTEMPTS) await this.sleep(1000 * 2 ** (attempt - 1));
    }
    throw new Error(`candles for ${productId} (${granularity}) failed: ${lastFailure}`);
  }
}

function toBar(candle: RawCandle): Bar | null {
  const bar = {
    t: Number(candle.start),
    o: Number(candle.open),
    h: Number(candle.high),
    l: Number(candle.low),
    c: Number(candle.close),
    v: Number(candle.volume),
  };
  const finite = [bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite);
  if (!finite || bar.h < bar.l || bar.o <= 0 || bar.c <= 0) return null;
  return bar;
}
