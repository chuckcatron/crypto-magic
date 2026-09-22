import { atr, crossedAbove, crossedBelow, ema, rsi } from '../indicators';
import type { Signal } from '../types/trading';
import { HOLD } from '../types/trading';
import type { Strategy, StrategyContext } from './types';

export interface TaEnsembleConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  emaTrendPeriod: number;
  rsiPeriod: number;
  /**
   * Refuse entries above this RSI. Set for *exhaustion*, not "overbought": an
   * EMA cross lags, so a valid cross in a real uptrend routinely prints RSI in
   * the 60s and 70s. Vetoing those rejects precisely the trades a trend
   * follower exists to take. Only a parabolic print should block entry.
   */
  rsiEntryMax: number;
  /** Exit outright above this RSI (blow-off top). */
  rsiExitMax: number;
  /** Refuse entries below this RSI — a bullish cross this weak is a dead-cat bounce. */
  rsiEntryMin: number;
  atrPeriod: number;
  atrStopMultiple: number;
  /** null lets the trailing stop decide the exit instead of a fixed target. */
  atrTakeProfitMultiple: number | null;
  /** ATR as a % of price. Below this the range can't cover fees. */
  minAtrPct: number;
  /** Above this the market is too violent for a fixed-fraction stop to survive. */
  maxAtrPct: number;
  requireTrendFilter: boolean;
  /**
   * Entries scoring below this are dropped.
   *
   * Deliberately low. The hard gates are the explicit vetoes above — trend
   * filter, RSI band, ATR band — and anything reaching the score has already
   * passed all of them. The score exists to RANK and SIZE setups, not to gate
   * them: confidence scales the position over [0.5x, 1x], so a marginal setup
   * takes a small bet rather than none.
   *
   * A high floor also has a structural bias. `trendScore` measures how far
   * above the long EMA price sits, which is near zero at exactly the moment
   * price reclaims that EMA — the trend reversal this strategy is built to
   * catch. Gating hard on the score would systematically skip the early entry
   * and admit only extended ones.
   */
  minConfidence: number;
}

export const DEFAULT_TA_ENSEMBLE_CONFIG: TaEnsembleConfig = {
  emaFastPeriod: 12,
  emaSlowPeriod: 26,
  emaTrendPeriod: 200,
  rsiPeriod: 14,
  rsiEntryMax: 80,
  rsiExitMax: 88,
  rsiEntryMin: 45,
  atrPeriod: 14,
  atrStopMultiple: 2,
  atrTakeProfitMultiple: 4,
  minAtrPct: 0.15,
  maxAtrPct: 8,
  requireTrendFilter: true,
  minConfidence: 0.35,
};

/**
 * Long-only trend-following ensemble for spot.
 *
 * Entry needs all of: a fast/slow EMA cross up, price above the long trend EMA,
 * RSI inside a sane band, and volatility inside a tradable band. Exit is the
 * mirror cross, an overbought blow-off, or (handled by the position manager)
 * the ATR stop.
 *
 * Deliberately boring. It exists to be a baseline that anything fancier has to
 * beat in the backtester before it gets real money.
 */
export class TaEnsembleStrategy implements Strategy {
  readonly name = 'ta-ensemble-v1';
  readonly warmupBars: number;
  readonly lookbackBars: number;

  constructor(private readonly config: TaEnsembleConfig = DEFAULT_TA_ENSEMBLE_CONFIG) {
    validateConfig(config);
    this.warmupBars =
      Math.max(
        config.emaSlowPeriod,
        config.requireTrendFilter ? config.emaTrendPeriod : 0,
        config.rsiPeriod + 1,
        config.atrPeriod + 1,
      ) + 1;
    // Three extra periods past warmup puts the seed's weight below 0.3% for the
    // longest EMA: (1 - 2/(n+1))^(3n) ≈ e^-6.
    const longest = Math.max(
      config.emaSlowPeriod,
      config.requireTrendFilter ? config.emaTrendPeriod : 0,
      config.rsiPeriod,
      config.atrPeriod,
    );
    this.lookbackBars = this.warmupBars + 3 * longest;
  }

  evaluate(ctx: StrategyContext): Signal {
    const { candles, position } = ctx;
    if (candles.length < this.warmupBars) return HOLD;

    const i = candles.length - 1;
    const closes = candles.map((c) => c.close);
    const cfg = this.config;

    const fast = ema(closes, cfg.emaFastPeriod);
    const slow = ema(closes, cfg.emaSlowPeriod);
    const trend = cfg.requireTrendFilter ? ema(closes, cfg.emaTrendPeriod) : [];
    const momentum = rsi(closes, cfg.rsiPeriod);
    const volatility = atr(candles, cfg.atrPeriod);

    const close = closes[i]!;
    const atrNow = volatility[i];
    const rsiNow = momentum[i];
    const trendNow = cfg.requireTrendFilter ? trend[i] : undefined;

    const indicators: Record<string, number | null> = {
      close,
      emaFast: fast[i] ?? null,
      emaSlow: slow[i] ?? null,
      emaTrend: trendNow ?? null,
      rsi: rsiNow ?? null,
      atr: atrNow ?? null,
      atrPct: atrNow !== undefined ? (atrNow / close) * 100 : null,
    };

    // Any missing indicator means we are still in warmup for that series. Never
    // guess — hold.
    if (atrNow === undefined || rsiNow === undefined) return { ...HOLD, indicators };
    if (cfg.requireTrendFilter && trendNow === undefined) return { ...HOLD, indicators };

    const atrPct = (atrNow / close) * 100;

    if (position) {
      return this.evaluateExit({ fast, slow, i, rsiNow, indicators });
    }
    return this.evaluateEntry({
      fast, slow, i, rsiNow, close, trendNow, atrPct, atrNow, indicators,
    });
  }

  private evaluateExit(args: {
    fast: (number | undefined)[];
    slow: (number | undefined)[];
    i: number;
    rsiNow: number;
    indicators: Record<string, number | null>;
  }): Signal {
    const { fast, slow, i, rsiNow, indicators } = args;
    const reasons: string[] = [];

    if (crossedBelow(fast, slow, i)) {
      reasons.push(
        `EMA${this.config.emaFastPeriod} crossed below EMA${this.config.emaSlowPeriod}`,
      );
    }
    if (rsiNow > this.config.rsiExitMax) {
      reasons.push(`RSI ${rsiNow.toFixed(1)} above blow-off threshold ${this.config.rsiExitMax}`);
    }

    if (reasons.length === 0) return { ...HOLD, indicators };
    return {
      action: 'EXIT_LONG',
      confidence: 1,
      reasons,
      exitReason: 'signal',
      indicators,
    };
  }

  private evaluateEntry(args: {
    fast: (number | undefined)[];
    slow: (number | undefined)[];
    i: number;
    rsiNow: number;
    close: number;
    trendNow: number | undefined;
    atrPct: number;
    atrNow: number;
    indicators: Record<string, number | null>;
  }): Signal {
    const { fast, slow, i, rsiNow, close, trendNow, atrPct, atrNow, indicators } = args;
    const cfg = this.config;

    // The cross is the trigger. Everything else is a veto or a score.
    if (!crossedAbove(fast, slow, i)) return { ...HOLD, indicators };

    const vetoes: string[] = [];
    if (cfg.requireTrendFilter && trendNow !== undefined && close <= trendNow) {
      vetoes.push(`price ${close.toFixed(2)} below trend EMA${cfg.emaTrendPeriod}`);
    }
    if (rsiNow > cfg.rsiEntryMax) vetoes.push(`RSI ${rsiNow.toFixed(1)} overbought`);
    if (rsiNow < cfg.rsiEntryMin) vetoes.push(`RSI ${rsiNow.toFixed(1)} in freefall`);
    if (atrPct < cfg.minAtrPct) vetoes.push(`ATR ${atrPct.toFixed(2)}% too quiet to cover fees`);
    if (atrPct > cfg.maxAtrPct) vetoes.push(`ATR ${atrPct.toFixed(2)}% too violent`);

    if (vetoes.length > 0) {
      return { action: 'HOLD', confidence: 0, reasons: vetoes, indicators };
    }

    const reasons = [`EMA${cfg.emaFastPeriod} crossed above EMA${cfg.emaSlowPeriod}`];
    if (cfg.requireTrendFilter) reasons.push(`price above trend EMA${cfg.emaTrendPeriod}`);
    reasons.push(`RSI ${rsiNow.toFixed(1)} in band`);
    reasons.push(`ATR ${atrPct.toFixed(2)}% tradable`);

    const confidence = scoreEntry({ rsiNow, close, trendNow, atrPct, atrNow, fast, i, cfg });
    if (confidence < cfg.minConfidence) {
      return {
        action: 'HOLD',
        confidence,
        reasons: [`confidence ${confidence.toFixed(2)} below floor ${cfg.minConfidence}`],
        indicators,
      };
    }

    return { action: 'ENTER_LONG', confidence, reasons, indicators };
  }
}

/**
 * Blends four independent reads into 0..1. Each term is bounded so no single
 * indicator can carry a weak setup over the line on its own.
 *
 * Three of the four terms are normalized by ATR rather than by percent. A fixed
 * percentage threshold means something completely different on BTC than on a
 * low-volatility pair, and something different on the same pair in a calm week
 * versus a violent one. ATR units travel.
 */
function scoreEntry(args: {
  rsiNow: number;
  close: number;
  trendNow: number | undefined;
  atrPct: number;
  atrNow: number;
  fast: (number | undefined)[];
  i: number;
  cfg: TaEnsembleConfig;
}): number {
  const { rsiNow, close, trendNow, atrPct, atrNow, fast, i, cfg } = args;
  if (atrNow <= 0) return 0;

  // 1. RSI comfort: best in the middle of the allowed band, worst at the edges.
  const bandMid = (cfg.rsiEntryMin + cfg.rsiEntryMax) / 2;
  const bandHalf = (cfg.rsiEntryMax - cfg.rsiEntryMin) / 2;
  const rsiScore = bandHalf > 0 ? clamp01(1 - Math.abs(rsiNow - bandMid) / bandHalf) : 0.5;

  // 2. Trend headroom, in ATRs above the long EMA. Saturates at 4 ATRs — beyond
  //    that we are extended, not stronger.
  const trendScore =
    trendNow === undefined ? 0.5 : clamp01((close - trendNow) / (TREND_HEADROOM_ATRS * atrNow));

  // 3. Thrust: how far the fast EMA climbed over the last half-period, in ATRs.
  //    This replaces measuring fast-vs-slow separation, which is zero by
  //    construction at the exact bar they cross and so scored nothing at all.
  const lookback = Math.max(2, Math.round(cfg.emaFastPeriod / 2));
  const prevFast = fast[i - lookback];
  const nowFast = fast[i];
  const thrustScore =
    prevFast === undefined || nowFast === undefined
      ? 0
      : clamp01((nowFast - prevFast) / (THRUST_ATRS * atrNow));

  // 4. Volatility sweet spot: peaks at the geometric middle of the allowed band.
  const target = Math.sqrt(cfg.minAtrPct * cfg.maxAtrPct);
  const volScore = clamp01(
    1 - Math.abs(Math.log(atrPct / target)) / Math.log(cfg.maxAtrPct / target),
  );

  const score = 0.3 * rsiScore + 0.25 * trendScore + 0.25 * thrustScore + 0.2 * volScore;
  return Math.round(clamp01(score) * 100) / 100;
}

/** Price this many ATRs above the trend EMA counts as maximum trend strength. */
const TREND_HEADROOM_ATRS = 4;
/** A fast-EMA rise of this many ATRs over half its period counts as maximum thrust. */
const THRUST_ATRS = 1;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function validateConfig(c: TaEnsembleConfig): void {
  if (c.emaFastPeriod >= c.emaSlowPeriod) {
    throw new RangeError('emaFastPeriod must be shorter than emaSlowPeriod');
  }
  if (c.rsiEntryMin >= c.rsiEntryMax) {
    throw new RangeError('rsiEntryMin must be below rsiEntryMax');
  }
  if (c.minAtrPct >= c.maxAtrPct) {
    throw new RangeError('minAtrPct must be below maxAtrPct');
  }
  if (c.atrStopMultiple <= 0) {
    throw new RangeError('atrStopMultiple must be positive');
  }
}
