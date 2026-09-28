import { Global, Module } from '@nestjs/common';
import {
  DEFAULT_REGIME_FILTER_CONFIG,
  DEFAULT_STOP_CONFIG,
  REGIME_FILTER_STOP_CONFIG,
  RegimeFilterStrategy,
  TaEnsembleStrategy,
  type RiskLimits,
  type StopConfig,
  type Strategy,
  type TaEnsembleConfig,
} from '@crypto-magic/core';
import { loadConfig, type AppConfig } from './config.schema';

import { APP_CONFIG, RISK_LIMITS, STOP_CONFIG, STRATEGY } from './tokens';

export { APP_CONFIG, RISK_LIMITS, STOP_CONFIG, STRATEGY };

export function toRiskLimits(cfg: AppConfig): RiskLimits {
  return {
    maxTotalNotional: cfg.MAX_TOTAL_NOTIONAL,
    maxPositionNotional: cfg.MAX_POSITION_NOTIONAL,
    maxOpenPositions: cfg.MAX_OPEN_POSITIONS,
    riskPerTradePct: cfg.RISK_PER_TRADE_PCT,
    maxDailyLoss: cfg.MAX_DAILY_LOSS,
    maxConsecutiveLosses: cfg.MAX_CONSECUTIVE_LOSSES,
    maxOrdersPerHour: cfg.MAX_ORDERS_PER_HOUR,
    maxSlippagePct: cfg.MAX_SLIPPAGE_PCT,
    minOrderNotional: cfg.MIN_ORDER_NOTIONAL,
  };
}

export function toStopConfig(cfg: AppConfig): StopConfig {
  return {
    ...DEFAULT_STOP_CONFIG,
    atrPeriod: cfg.ATR_PERIOD,
    atrStopMultiple: cfg.ATR_STOP_MULTIPLE,
    // A take-profit multiple of zero means "no fixed target, let the trail run".
    atrTakeProfitMultiple: cfg.ATR_TAKE_PROFIT_MULTIPLE > 0 ? cfg.ATR_TAKE_PROFIT_MULTIPLE : null,
    trailingEnabled: cfg.TRAILING_STOP_ENABLED,
    trailActivationAtrMultiple: cfg.TRAIL_ACTIVATION_ATR_MULTIPLE,
    maxHoldingBars: cfg.MAX_HOLDING_BARS,
  };
}

/** The strategy STRATEGY selects. The regime filter runs exactly as tested. */
export function createStrategy(cfg: AppConfig): Strategy {
  return cfg.STRATEGY === 'regime'
    ? new RegimeFilterStrategy(DEFAULT_REGIME_FILTER_CONFIG)
    : new TaEnsembleStrategy(toStrategyConfig(cfg));
}

/**
 * The stops the engine runs, which belong to the strategy.
 *
 * The regime filter uses the same disaster-floor stops as its backtest, so the
 * ta-ensemble stop settings in .env do not apply to it. `toStopConfig` stays
 * the ta-ensemble mapping because the backtest CLI picks stops per --strategy.
 */
export function stopConfigFor(cfg: AppConfig): StopConfig {
  return cfg.STRATEGY === 'regime' ? REGIME_FILTER_STOP_CONFIG : toStopConfig(cfg);
}

export function toStrategyConfig(cfg: AppConfig): TaEnsembleConfig {
  return {
    emaFastPeriod: cfg.EMA_FAST_PERIOD,
    emaSlowPeriod: cfg.EMA_SLOW_PERIOD,
    emaTrendPeriod: cfg.EMA_TREND_PERIOD,
    rsiPeriod: cfg.RSI_PERIOD,
    rsiEntryMax: cfg.RSI_ENTRY_MAX,
    rsiEntryMin: cfg.RSI_ENTRY_MIN,
    rsiExitMax: cfg.RSI_EXIT_MAX,
    atrPeriod: cfg.ATR_PERIOD,
    atrStopMultiple: cfg.ATR_STOP_MULTIPLE,
    atrTakeProfitMultiple: cfg.ATR_TAKE_PROFIT_MULTIPLE > 0 ? cfg.ATR_TAKE_PROFIT_MULTIPLE : null,
    minAtrPct: cfg.MIN_ATR_PCT,
    maxAtrPct: cfg.MAX_ATR_PCT,
    requireTrendFilter: cfg.REQUIRE_TREND_FILTER,
    minConfidence: cfg.MIN_CONFIDENCE,
  };
}

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: RISK_LIMITS,
      useFactory: (cfg: AppConfig) => toRiskLimits(cfg),
      inject: [APP_CONFIG],
    },
    {
      provide: STOP_CONFIG,
      useFactory: (cfg: AppConfig) => stopConfigFor(cfg),
      inject: [APP_CONFIG],
    },
    {
      provide: STRATEGY,
      useFactory: (cfg: AppConfig) => createStrategy(cfg),
      inject: [APP_CONFIG],
    },
  ],
  exports: [APP_CONFIG, RISK_LIMITS, STOP_CONFIG, STRATEGY],
})
export class ConfigModule {}
