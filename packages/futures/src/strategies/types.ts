import type { MarketSeries } from '../series';
import type { EntrySignal } from '../types';

export type IntradayStrategyId = 'F1' | 'F2' | 'F3';

/**
 * A strategy that trades one coin on 5-minute bars, long or short.
 *
 * Stateless: every evaluation reads only the trailing windows the protocol
 * names, from closed bars. So the backtest and a restarted paper engine give
 * the same answer for the same bars, with nothing to replay.
 */
export interface IntradayStrategy {
  readonly id: IntradayStrategyId;
  readonly name: string;
  /**
   * 5-minute bars of history the series must hold before every window this
   * strategy reads can be full. The paper engine fetches at least this much.
   */
  readonly warmupM5Bars: number;
  /** Called at every 5-minute close. Returns a signal, or null for no trade. */
  evaluate(series: MarketSeries): EntrySignal | null;
}
