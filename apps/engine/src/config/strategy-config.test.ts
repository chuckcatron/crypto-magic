import { describe, expect, it } from 'vitest';
import { REGIME_FILTER_STOP_CONFIG } from '@crypto-magic/core';
import { createStrategy, stopConfigFor, toStopConfig } from './config.module';
import { loadConfig } from './config.schema';

const load = (env: Record<string, string>) => loadConfig({ LOG_LEVEL: 'fatal', ...env });

describe('STRATEGY selection', () => {
  it('defaults to ta-ensemble, unchanged', () => {
    const config = load({});
    expect(config.STRATEGY).toBe('ta-ensemble');
    expect(createStrategy(config).name).toBe('ta-ensemble-v1');
    expect(stopConfigFor(config)).toEqual(toStopConfig(config));
  });

  it('runs the regime filter exactly as Experiment 001 tested it', () => {
    // ta-ensemble stop settings present, and ignored: the regime filter keeps
    // its own disaster-floor stops.
    const config = load({
      STRATEGY: 'regime',
      GRANULARITY: 'ONE_DAY',
      ATR_STOP_MULTIPLE: '2',
      TRAILING_STOP_ENABLED: 'true',
    });
    expect(createStrategy(config).name).toBe('regime-sma200');
    expect(stopConfigFor(config)).toEqual(REGIME_FILTER_STOP_CONFIG);
  });

  it('refuses the regime filter on anything but daily bars', () => {
    expect(() => load({ STRATEGY: 'regime', GRANULARITY: 'ONE_HOUR' })).toThrow(
      /STRATEGY=regime needs GRANULARITY=ONE_DAY/,
    );
  });

  it('defaults the allocation to 100% and bounds it to (0, 100]', () => {
    expect(load({}).REGIME_ALLOCATION_PCT).toBe(100);
    expect(load({ REGIME_ALLOCATION_PCT: '40' }).REGIME_ALLOCATION_PCT).toBe(40);
    expect(() => load({ REGIME_ALLOCATION_PCT: '0' })).toThrow();
    expect(() => load({ REGIME_ALLOCATION_PCT: '150' })).toThrow();
  });

  it('keeps the backtest stop mapping independent of STRATEGY', () => {
    // run-backtest picks stops per --strategy; .env saying regime must not
    // quietly swap the stops of a ta-ensemble backtest.
    const config = load({ STRATEGY: 'regime', GRANULARITY: 'ONE_DAY' });
    expect(toStopConfig(config)).not.toEqual(REGIME_FILTER_STOP_CONFIG);
  });
});
