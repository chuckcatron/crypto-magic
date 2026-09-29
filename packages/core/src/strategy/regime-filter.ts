import { atr, sma } from '../indicators';
import { DEFAULT_STOP_CONFIG, type StopConfig } from '../position/stops';
import { HOLD, type Signal } from '../types/trading';
import type { Strategy, StrategyContext } from './types';

export interface RegimeFilterConfig {
  /** Moving-average length in bars. 200 on daily bars is the conventional value. */
  readonly smaPeriod: number;
  readonly atrPeriod: number;
  /**
   * A faster average that must also be below the close to stay in (EXPERIMENT-007).
   * With it, the strategy holds only while the close is above BOTH averages:
   * it enters when above both and exits when below either. Requiring both on
   * entry is what stops an exit on the fast line being bought straight back
   * the next day while the close is still above the slow one. Unset: the
   * regime filter exactly as tested in EXPERIMENT-001.
   */
  readonly exitSmaPeriod?: number;
}

export const DEFAULT_REGIME_FILTER_CONFIG: RegimeFilterConfig = { smaPeriod: 200, atrPeriod: 14 };

/**
 * Stops for a regime strategy: a disaster floor and nothing else.
 *
 * The whole premise is to sit through normal volatility and let the regime
 * decide the exit. A 2-ATR stop or a 4-ATR target would shake it out of exactly
 * the long trends it exists to hold — which is the failure this strategy was
 * designed to fix in ta-ensemble-v1. The 10-ATR stop only bounds a crash
 * between two daily closes.
 */
export const REGIME_FILTER_STOP_CONFIG: StopConfig = {
  ...DEFAULT_STOP_CONFIG,
  atrPeriod: 14,
  atrStopMultiple: 10,
  atrTakeProfitMultiple: null,
  trailingEnabled: false,
  maxHoldingBars: null,
};

/**
 * Hold the asset while it closes above its long moving average; hold cash
 * otherwise.
 *
 * Stateless by design: whenever it is flat and the regime is up, it enters, so
 * it never "misses" a bull market for want of a fresh crossover. Has no
 * parameter tuned on this project's data — see
 * docs/EXPERIMENT-001-regime-filter.md.
 */
export class RegimeFilterStrategy implements Strategy {
  readonly name: string;
  readonly warmupBars: number;
  readonly lookbackBars: number;

  constructor(private readonly config: RegimeFilterConfig = DEFAULT_REGIME_FILTER_CONFIG) {
    if (!Number.isInteger(config.smaPeriod) || config.smaPeriod < 2) {
      throw new RangeError('smaPeriod must be an integer of at least 2');
    }
    const exit = config.exitSmaPeriod;
    if (exit !== undefined && (!Number.isInteger(exit) || exit < 2 || exit >= config.smaPeriod)) {
      throw new RangeError('exitSmaPeriod must be an integer from 2 to below smaPeriod');
    }
    this.name =
      exit === undefined
        ? `regime-sma${config.smaPeriod}`
        : `regime-sma${config.smaPeriod}-exit${exit}`;
    this.warmupBars = Math.max(config.smaPeriod, config.atrPeriod + 1) + 1;
    // An SMA has no seed to shed, so it needs only its own window; ATR's
    // Wilder smoothing gets three periods of margin.
    this.lookbackBars = this.warmupBars + 3 * config.atrPeriod;
  }

  evaluate(ctx: StrategyContext): Signal {
    const { candles, position } = ctx;
    if (candles.length < this.warmupBars) return HOLD;

    const i = candles.length - 1;
    const close = candles[i]!.close;
    const average = sma(
      candles.map((c) => c.close),
      this.config.smaPeriod,
    )[i];
    const volatility = atr(candles, this.config.atrPeriod)[i];
    const exitPeriod = this.config.exitSmaPeriod;
    const exitAverage =
      exitPeriod === undefined
        ? undefined
        : sma(
            candles.map((c) => c.close),
            exitPeriod,
          )[i];

    const indicators = {
      close,
      sma: average ?? null,
      atr: volatility ?? null,
      distancePct: average ? ((close - average) / average) * 100 : null,
      ...(exitPeriod === undefined ? {} : { exitSma: exitAverage ?? null }),
    };
    if (average === undefined || volatility === undefined) return { ...HOLD, indicators };
    if (exitPeriod !== undefined && exitAverage === undefined) return { ...HOLD, indicators };

    const aboveSlow = close > average;
    const aboveFast = exitAverage === undefined || close > exitAverage;
    const slow = `SMA${this.config.smaPeriod} ${average.toFixed(2)}`;
    const fast = exitAverage === undefined ? '' : `SMA${exitPeriod} ${exitAverage.toFixed(2)}`;

    if (!position && aboveSlow && aboveFast) {
      return {
        action: 'ENTER_LONG',
        confidence: 1,
        reasons: [`close ${close.toFixed(2)} above ${slow}${fast ? ` and ${fast}` : ''}`],
        indicators,
      };
    }
    if (position && !(aboveSlow && aboveFast)) {
      return {
        action: 'EXIT_LONG',
        confidence: 1,
        reasons: [`close ${close.toFixed(2)} fell below ${aboveSlow ? fast : slow}`],
        exitReason: 'signal',
        indicators,
      };
    }
    return { ...HOLD, indicators };
  }
}
