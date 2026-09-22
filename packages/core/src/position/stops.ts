import { D, Decimal, type Numeric } from '../money';
import type { ExitReason, Position } from '../types/trading';

export interface StopConfig {
  /** ATR lookback. Must match the strategy's, or stops and signals disagree. */
  readonly atrPeriod: number;
  /** Initial stop distance below entry, in ATRs. */
  readonly atrStopMultiple: number;
  /** Fixed profit target in ATRs above entry. null leaves the trail in charge. */
  readonly atrTakeProfitMultiple: number | null;
  readonly trailingEnabled: boolean;
  /**
   * Don't start trailing until price has run this many ATRs past entry. Trailing
   * from bar one just converts normal noise into a stop-out.
   */
  readonly trailActivationAtrMultiple: number;
  /** Force an exit after this many bars in the trade. null disables. */
  readonly maxHoldingBars: number | null;
}

export const DEFAULT_STOP_CONFIG: StopConfig = {
  atrPeriod: 14,
  atrStopMultiple: 2,
  atrTakeProfitMultiple: 4,
  trailingEnabled: true,
  trailActivationAtrMultiple: 1,
  maxHoldingBars: 240,
};

export function initialStopPrice(entryPrice: Numeric, atrValue: Numeric, multiple: number): Decimal {
  const stop = D(entryPrice).minus(D(atrValue).mul(multiple));
  // A stop at or below zero is meaningless; clamp to a token fraction of entry
  // so the position still has a defined risk unit.
  return stop.lte(0) ? D(entryPrice).mul(0.5) : stop;
}

export function takeProfitPrice(
  entryPrice: Numeric,
  atrValue: Numeric,
  multiple: number | null,
): Decimal | null {
  if (multiple === null) return null;
  return D(entryPrice).plus(D(atrValue).mul(multiple));
}

export function openPosition(args: {
  productId: string;
  baseSize: Numeric;
  entryPrice: Numeric;
  atrValue: Numeric;
  openedAt: number;
  config: StopConfig;
}): Position {
  const entry = D(args.entryPrice);
  return {
    productId: args.productId,
    baseSize: D(args.baseSize),
    averageEntryPrice: entry,
    openedAt: args.openedAt,
    stopPrice: initialStopPrice(entry, args.atrValue, args.config.atrStopMultiple),
    highWaterPrice: entry,
    takeProfitPrice: takeProfitPrice(entry, args.atrValue, args.config.atrTakeProfitMultiple),
    entryAtr: D(args.atrValue),
  };
}

/**
 * Ratchet the trailing stop against a new price. The stop only ever moves up —
 * a stop that can loosen is not a stop.
 */
export function ratchetStop(
  position: Position,
  currentPrice: Numeric,
  config: StopConfig,
): Position {
  const price = D(currentPrice);
  const highWater = Decimal.max(position.highWaterPrice, price);
  if (!config.trailingEnabled) {
    return highWater.eq(position.highWaterPrice) ? position : { ...position, highWaterPrice: highWater };
  }

  const activationPrice = position.averageEntryPrice.plus(
    position.entryAtr.mul(config.trailActivationAtrMultiple),
  );
  if (highWater.lt(activationPrice)) {
    return highWater.eq(position.highWaterPrice) ? position : { ...position, highWaterPrice: highWater };
  }

  const candidate = highWater.minus(position.entryAtr.mul(config.atrStopMultiple));
  const stopPrice = Decimal.max(position.stopPrice, candidate);

  if (stopPrice.eq(position.stopPrice) && highWater.eq(position.highWaterPrice)) return position;
  return { ...position, stopPrice, highWaterPrice: highWater };
}

/**
 * Decide whether a position must be closed, given a bar's extremes.
 *
 * When a single bar touches both the stop and the target we assume the stop hit
 * first. We cannot see intrabar order, and assuming the good outcome is exactly
 * how a backtest learns to lie.
 */
export function checkStops(args: {
  position: Position;
  low: Numeric;
  high: Numeric;
  barsHeld: number;
  config: StopConfig;
}): ExitReason | null {
  const { position, config } = args;
  const low = D(args.low);
  const high = D(args.high);

  if (low.lte(position.stopPrice)) {
    return position.stopPrice.gt(position.averageEntryPrice) ? 'trailing_stop' : 'stop_loss';
  }
  if (position.takeProfitPrice && high.gte(position.takeProfitPrice)) return 'take_profit';
  if (config.maxHoldingBars !== null && args.barsHeld >= config.maxHoldingBars) {
    return 'max_holding_period';
  }
  return null;
}

/** The price a stop-triggered exit is assumed to fill at. */
export function exitFillPrice(
  position: Position,
  reason: ExitReason,
  barClose: Numeric,
): Decimal {
  switch (reason) {
    case 'stop_loss':
    case 'trailing_stop':
      return position.stopPrice;
    case 'take_profit':
      return position.takeProfitPrice ?? D(barClose);
    default:
      return D(barClose);
  }
}
