import type { Candle } from '../types/market';
import type { Position, Signal } from '../types/trading';

export interface StrategyContext {
  /**
   * Closed candles in ascending time order. The last element is the bar being
   * decided on. Never contains the in-progress bar — acting on an unclosed bar
   * makes backtests unreproducible and live results worse than the backtest.
   */
  readonly candles: Candle[];
  readonly position: Position | null;
  readonly now: number;
}

export interface Strategy {
  readonly name: string;
  /** Minimum closed bars required before `evaluate` can return anything but HOLD. */
  readonly warmupBars: number;
  /**
   * How much history every evaluation sees — live AND in the backtester.
   *
   * An EMA seeded from an SMA carries its seed's influence for a long time: with
   * period 200, the seed still accounts for ~59% of the value 54 bars later and
   * under 0.3% after 600. The live engine used to fetch ~254 bars, so its trend
   * filter was mostly its seed, while the backtester computed the same EMA over
   * the entire history. Different indicator, same name — the backtest was not
   * testing the bot. Both now use exactly this many trailing bars.
   */
  readonly lookbackBars: number;
  evaluate(ctx: StrategyContext): Signal;
}
