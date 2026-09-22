/** Candle granularities supported by Coinbase Advanced Trade. */
export const GRANULARITIES = [
  'ONE_MINUTE',
  'FIVE_MINUTE',
  'FIFTEEN_MINUTE',
  'THIRTY_MINUTE',
  'ONE_HOUR',
  'TWO_HOUR',
  'SIX_HOUR',
  'ONE_DAY',
] as const;

export type Granularity = (typeof GRANULARITIES)[number];

export const GRANULARITY_SECONDS: Record<Granularity, number> = {
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1800,
  ONE_HOUR: 3600,
  TWO_HOUR: 7200,
  SIX_HOUR: 21600,
  ONE_DAY: 86400,
};

/**
 * A closed OHLCV bar. `openTime` is the UNIX second at which the bar opened.
 * Strategies only ever see closed bars — see `isClosed` in the ingest layer.
 */
export interface Candle {
  readonly productId: string;
  readonly granularity: Granularity;
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Exchange trading rules for a product. Orders that violate these are rejected. */
export interface ProductSpec {
  readonly productId: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  /** Smallest tradable increment of the base asset, e.g. "0.00000001". */
  readonly baseIncrement: string;
  /** Smallest price increment, e.g. "0.01". */
  readonly quoteIncrement: string;
  /** Minimum order value in quote currency, e.g. "1". */
  readonly minMarketFunds: string;
  readonly tradingDisabled: boolean;
}

export interface Ticker {
  readonly productId: string;
  readonly price: number;
  readonly timestamp: number;
}

export function candleCloseTime(candle: Candle): number {
  return candle.openTime + GRANULARITY_SECONDS[candle.granularity];
}
