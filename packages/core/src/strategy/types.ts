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
  evaluate(ctx: StrategyContext): Signal;
}
