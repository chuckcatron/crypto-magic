import { describe, expect, it } from 'vitest';
import { toCandle, toOrderResult, toOrderStatus, toProductSpec } from './mapping';

describe('toCandle', () => {
  it('parses Coinbase string numerics into a typed candle', () => {
    const candle = toCandle(
      { start: '1700000000', low: '99.5', high: '101.25', open: '100', close: '100.75', volume: '12.5' },
      'BTC-USD',
      'ONE_HOUR',
    );
    expect(candle).toEqual({
      productId: 'BTC-USD',
      granularity: 'ONE_HOUR',
      openTime: 1_700_000_000,
      open: 100,
      high: 101.25,
      low: 99.5,
      close: 100.75,
      volume: 12.5,
    });
  });
});

describe('toProductSpec', () => {
  const base = {
    product_id: 'BTC-USD',
    base_name: 'BTC',
    quote_name: 'USD',
    base_increment: '0.00000001',
    quote_increment: '0.01',
    quote_min_size: '1',
    trading_disabled: false,
  };

  it('maps the tradable case', () => {
    expect(toProductSpec(base).tradingDisabled).toBe(false);
  });

  it.each([
    ['trading_disabled', { trading_disabled: true }],
    ['is_disabled', { is_disabled: true }],
    ['cancel_only', { cancel_only: true }],
    ['limit_only', { limit_only: true }],
  ])('treats %s as untradable, since market orders would be rejected', (_label, patch) => {
    expect(toProductSpec({ ...base, ...patch }).tradingDisabled).toBe(true);
  });
});

describe('toOrderStatus', () => {
  it('maps known statuses', () => {
    expect(toOrderStatus('FILLED')).toBe('FILLED');
    expect(toOrderStatus('CANCEL_QUEUED')).toBe('CANCELLED');
    expect(toOrderStatus('QUEUED')).toBe('PENDING');
  });

  it('treats anything unrecognised as FAILED rather than assuming success', () => {
    expect(toOrderStatus('SOMETHING_NEW')).toBe('FAILED');
  });
});

describe('toOrderResult', () => {
  it('defaults missing numeric fields to zero instead of NaN', () => {
    const result = toOrderResult({
      order_id: 'o1',
      client_order_id: 'c1',
      product_id: 'BTC-USD',
      side: 'BUY',
      status: 'PENDING',
      filled_size: '',
      average_filled_price: '',
      total_fees: '',
      created_time: '2026-01-01T00:00:00Z',
    });
    expect(result.filledSize.toNumber()).toBe(0);
    expect(result.averageFillPrice.toNumber()).toBe(0);
    expect(result.fee.toNumber()).toBe(0);
  });

  it('surfaces a rejection message', () => {
    const result = toOrderResult({
      order_id: 'o2', client_order_id: 'c2', product_id: 'BTC-USD', side: 'BUY',
      status: 'FAILED', filled_size: '0', average_filled_price: '0', total_fees: '0',
      created_time: '2026-01-01T00:00:00Z', reject_message: 'insufficient funds',
    });
    expect(result.rejectReason).toBe('insufficient funds');
  });
});
