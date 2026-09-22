import type { Candle, Granularity, ProductSpec } from '../types/market';
import { GRANULARITY_SECONDS } from '../types/market';

export const TEST_PRODUCT: ProductSpec = {
  productId: 'BTC-USD',
  baseCurrency: 'BTC',
  quoteCurrency: 'USD',
  baseIncrement: '0.00000001',
  quoteIncrement: '0.01',
  minMarketFunds: '1',
  tradingDisabled: false,
};

/** Build candles from a close series, with a fixed intrabar range around each close. */
export function candlesFromCloses(
  closes: number[],
  opts: {
    granularity?: Granularity;
    startTime?: number;
    productId?: string;
    /** Half-range as a fraction of close, e.g. 0.005 = +/-0.5%. */
    rangePct?: number;
  } = {},
): Candle[] {
  const granularity = opts.granularity ?? 'ONE_HOUR';
  const step = GRANULARITY_SECONDS[granularity];
  const start = opts.startTime ?? 1_700_000_000;
  const rangePct = opts.rangePct ?? 0.005;

  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    const band = close * rangePct;
    return {
      productId: opts.productId ?? 'BTC-USD',
      granularity,
      openTime: start + i * step,
      open,
      high: Math.max(open, close) + band,
      low: Math.min(open, close) - band,
      close,
      volume: 100,
    };
  });
}

/** Deterministic pseudo-random walk — seeded so tests never flake. */
export function randomWalk(length: number, opts: { start?: number; volatility?: number; drift?: number; seed?: number } = {}): number[] {
  let seed = opts.seed ?? 42;
  const next = () => {
    // xorshift32: small, deterministic, good enough for test fixtures.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };

  const volatility = opts.volatility ?? 0.01;
  const drift = opts.drift ?? 0;
  let price = opts.start ?? 100;
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    price = Math.max(0.01, price * (1 + drift + next() * volatility));
    out.push(Math.round(price * 100) / 100);
  }
  return out;
}

/**
 * A quiet, slightly-drifting-down market followed by a clean sustained rally —
 * the setup the strategy is built for.
 *
 * Two details matter, and both were learned the hard way:
 *
 *   - The quiet leg drifts gently DOWN with small two-sided noise. A perfectly
 *     flat leg has no losing bars at all, so RSI reads a degenerate 100 on the
 *     first up-bar. A wobbling flat leg instead crosses the EMAs repeatedly on
 *     noise, and the last of those crosses lands just before the rally, so the
 *     rally never produces a fresh cross to trade. A slight downdrift keeps the
 *     fast EMA pinned below the slow one until the rally genuinely reverses it.
 *   - The rally is steep relative to the noise, so it reads as a real trend
 *     rather than as more noise.
 */
export function flatThenRally(
  quietBars: number,
  rallyBars: number,
  start = 100,
  perBarGain = 0.008,
): number[] {
  // The decline is a fixed TOTAL, not a per-bar rate. A per-bar rate makes a
  // 220-bar quiet leg fall twice as far as a 120-bar one, which drags the long
  // trend EMA so far above price that the rally cannot reclaim it before the
  // fast/slow cross fires — the trend filter then correctly vetoes an entry the
  // fixture was written to produce.
  const totalDecline = 0.02;
  const span = Math.max(1, quietBars - 1);
  const quiet = Array.from(
    { length: quietBars },
    (_, i) => start * (1 - (totalDecline * i) / span) + (i % 2 === 0 ? 0.1 : -0.1),
  );
  const base = quiet.at(-1) ?? start;
  const rally = Array.from({ length: rallyBars }, (_, i) => base * (1 + perBarGain) ** (i + 1));
  return [...quiet, ...rally];
}
