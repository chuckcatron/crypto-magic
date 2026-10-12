import { flushCatcher } from './flush-catcher';
import { squeezeBreakout } from './squeeze-breakout';
import { trendPullback } from './trend-pullback';
import type { IntradayStrategy, IntradayStrategyId } from './types';

export * from './types';
export { flushCatcher, squeezeBreakout, trendPullback };

export const INTRADAY_STRATEGIES: Readonly<Record<IntradayStrategyId, IntradayStrategy>> = {
  F1: flushCatcher,
  F2: squeezeBreakout,
  F3: trendPullback,
};

/** The coins F1–F3 trade in EXPERIMENT-008, by their spot product (the price proxy). */
export const INTRADAY_PRODUCTS = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;
