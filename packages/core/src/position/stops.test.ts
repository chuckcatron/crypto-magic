import { describe, expect, it } from 'vitest';
import { D } from '../money';
import {
  DEFAULT_STOP_CONFIG,
  checkStops,
  exitFillPrice,
  initialStopPrice,
  openPosition,
  ratchetStop,
} from './stops';

const config = { ...DEFAULT_STOP_CONFIG, atrStopMultiple: 2, trailActivationAtrMultiple: 1 };

const position = openPosition({
  productId: 'BTC-USD',
  baseSize: 1,
  entryPrice: 100,
  atrValue: 5,
  openedAt: 0,
  config,
});

describe('initialStopPrice', () => {
  it('places the stop a multiple of ATR below entry', () => {
    expect(initialStopPrice(100, 5, 2).toNumber()).toBe(90);
  });

  it('never returns a stop at or below zero', () => {
    expect(initialStopPrice(100, 90, 2).toNumber()).toBe(50);
  });
});

describe('openPosition', () => {
  it('derives the stop and target from entry ATR', () => {
    expect(position.stopPrice.toNumber()).toBe(90);
    expect(position.takeProfitPrice?.toNumber()).toBe(120);
    expect(position.highWaterPrice.toNumber()).toBe(100);
  });
});

describe('ratchetStop', () => {
  it('does not trail until price clears the activation threshold', () => {
    const next = ratchetStop(position, 104, config); // activation is 105
    expect(next.stopPrice.toNumber()).toBe(90);
    expect(next.highWaterPrice.toNumber()).toBe(104);
  });

  it('raises the stop once the trade is far enough in profit', () => {
    const next = ratchetStop(position, 115, config);
    expect(next.stopPrice.toNumber()).toBe(105); // 115 - 2*5
  });

  it('never lowers a stop that has already ratcheted up', () => {
    const raised = ratchetStop(position, 115, config);
    const pulledBack = ratchetStop(raised, 106, config);
    expect(pulledBack.stopPrice.toNumber()).toBe(105);
    expect(pulledBack.highWaterPrice.toNumber()).toBe(115);
  });

  it('only tracks the high water mark when trailing is disabled', () => {
    const next = ratchetStop(position, 130, { ...config, trailingEnabled: false });
    expect(next.stopPrice.toNumber()).toBe(90);
    expect(next.highWaterPrice.toNumber()).toBe(130);
  });
});

describe('checkStops', () => {
  it('reports a stop loss when the bar trades through the initial stop', () => {
    expect(checkStops({ position, low: 89, high: 101, barsHeld: 1, config })).toBe('stop_loss');
  });

  it('distinguishes a trailing stop once the stop sits above entry', () => {
    const raised = ratchetStop(position, 115, config); // stop 105 > entry 100
    expect(checkStops({ position: raised, low: 104, high: 116, barsHeld: 5, config })).toBe(
      'trailing_stop',
    );
  });

  it('reports the take profit when the bar reaches the target', () => {
    expect(checkStops({ position, low: 99, high: 121, barsHeld: 1, config })).toBe('take_profit');
  });

  it('assumes the stop hit first when one bar touches both', () => {
    expect(checkStops({ position, low: 89, high: 121, barsHeld: 1, config })).toBe('stop_loss');
  });

  it('forces an exit after the maximum holding period', () => {
    const capped = { ...config, maxHoldingBars: 10 };
    expect(checkStops({ position, low: 99, high: 101, barsHeld: 10, config: capped })).toBe(
      'max_holding_period',
    );
  });

  it('returns null while the position is within bounds', () => {
    expect(checkStops({ position, low: 95, high: 110, barsHeld: 1, config })).toBeNull();
  });
});

describe('exitFillPrice', () => {
  it('fills a stopped-out position at the stop, not the close', () => {
    expect(exitFillPrice(position, 'stop_loss', 70).toNumber()).toBe(90);
  });

  it('fills a target exit at the target', () => {
    expect(exitFillPrice(position, 'take_profit', 200).toNumber()).toBe(120);
  });

  it('fills a signal exit at the bar close', () => {
    expect(exitFillPrice(position, 'signal', 103).toNumber()).toBe(103);
  });
});

describe('position immutability', () => {
  it('returns the same object when nothing changed', () => {
    const same = ratchetStop(position, 100, config);
    expect(same).toBe(position);
    expect(D(position.stopPrice).toNumber()).toBe(90);
  });
});
