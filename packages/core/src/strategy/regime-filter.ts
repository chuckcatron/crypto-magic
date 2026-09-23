import { atr, sma } from '../indicators';
import { DEFAULT_STOP_CONFIG, type StopConfig } from '../position/stops';
import { HOLD, type Signal } from '../types/trading';
import type { Strategy, StrategyContext } from './types';

export interface RegimeFilterConfig {
  /** Moving-average length in bars. 200 on daily bars is the conventional value. */
  readonly smaPeriod: number;
  readonly atrPeriod: number;
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
    this.name = `regime-sma${config.smaPeriod}`;
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
    const average = sma(candles.map((c) => c.close), this.config.smaPeriod)[i];
    const volatility = atr(candles, this.config.atrPeriod)[i];

    const indicators = {
      close,
      sma: average ?? null,
      atr: volatility ?? null,
      distancePct: average ? ((close - average) / average) * 100 : null,
    };
    if (average === undefined || volatility === undefined) return { ...HOLD, indicators };

    const regime = close > average ? 'up' : 'down';

    if (!position && regime === 'up') {
      return {
        action: 'ENTER_LONG',
        confidence: 1,
        reasons: [`close ${close.toFixed(2)} above SMA${this.config.smaPeriod} ${average.toFixed(2)}`],
        indicators,
      };
    }
    if (position && regime === 'down') {
      return {
        action: 'EXIT_LONG',
        confidence: 1,
        reasons: [`close ${close.toFixed(2)} fell below SMA${this.config.smaPeriod} ${average.toFixed(2)}`],
        exitReason: 'signal',
        indicators,
      };
    }
    return { ...HOLD, indicators };
  }
}
