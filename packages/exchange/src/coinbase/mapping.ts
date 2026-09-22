import { D, type Candle, type Granularity, type ProductSpec } from '@crypto-magic/core';
import type { OrderResult, OrderStatus } from '../types';

/** Coinbase returns every number as a string. Parse defensively, never with Number(). */
export function toCandle(
  raw: { start: string; low: string; high: string; open: string; close: string; volume: string },
  productId: string,
  granularity: Granularity,
): Candle {
  return {
    productId,
    granularity,
    openTime: Number.parseInt(raw.start, 10),
    open: Number.parseFloat(raw.open),
    high: Number.parseFloat(raw.high),
    low: Number.parseFloat(raw.low),
    close: Number.parseFloat(raw.close),
    volume: Number.parseFloat(raw.volume),
  };
}

export function toProductSpec(raw: {
  product_id: string;
  base_name: string;
  quote_name: string;
  base_increment: string;
  quote_increment: string;
  quote_min_size: string;
  trading_disabled: boolean;
  is_disabled?: boolean;
  cancel_only?: boolean;
  limit_only?: boolean;
  status?: string;
}): ProductSpec {
  return {
    productId: raw.product_id,
    baseCurrency: raw.base_name,
    quoteCurrency: raw.quote_name,
    baseIncrement: raw.base_increment,
    quoteIncrement: raw.quote_increment,
    minMarketFunds: raw.quote_min_size,
    // `trading_disabled` alone is not enough: a cancel-only or limit-only
    // product will reject the market orders this engine places, so treat those
    // as untradable rather than discovering it at order time.
    tradingDisabled:
      raw.trading_disabled ||
      raw.is_disabled === true ||
      raw.cancel_only === true ||
      raw.limit_only === true,
  };
}

const STATUS_MAP: Record<string, OrderStatus> = {
  PENDING: 'PENDING',
  OPEN: 'OPEN',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  CANCEL_QUEUED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  UNKNOWN_ORDER_STATUS: 'FAILED',
  QUEUED: 'PENDING',
};

export function toOrderStatus(raw: string): OrderStatus {
  return STATUS_MAP[raw.toUpperCase()] ?? 'FAILED';
}

export function toOrderResult(raw: {
  order_id: string;
  client_order_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  status: string;
  filled_size: string;
  average_filled_price: string;
  total_fees: string;
  created_time: string;
  reject_reason?: string;
  reject_message?: string;
}): OrderResult {
  const rejectReason = raw.reject_message || raw.reject_reason;
  return {
    orderId: raw.order_id,
    clientOrderId: raw.client_order_id,
    productId: raw.product_id,
    side: raw.side,
    status: toOrderStatus(raw.status),
    filledSize: D(raw.filled_size || '0'),
    averageFillPrice: D(raw.average_filled_price || '0'),
    fee: D(raw.total_fees || '0'),
    createdAt: Date.parse(raw.created_time) || Date.now(),
    ...(rejectReason ? { rejectReason } : {}),
  };
}
