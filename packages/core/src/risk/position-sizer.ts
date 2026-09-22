import { D, Decimal, floorToIncrement, type Numeric } from '../money';
import type { ProductSpec } from '../types/market';
import type { RiskLimits } from './limits';

export interface SizingInput {
  readonly equity: Numeric;
  readonly availableQuote: Numeric;
  readonly entryPrice: Numeric;
  readonly stopPrice: Numeric;
  /** Sum of the value of all currently open positions. */
  readonly openNotional: Numeric;
  readonly product: ProductSpec;
  readonly limits: RiskLimits;
  /** Strategy confidence 0..1. Scales size between half and full allocation. */
  readonly confidence: number;
}

export interface SizingResult {
  readonly baseSize: Decimal;
  readonly notional: Decimal;
  /** Every cap that actually bound the result, in the order applied. */
  readonly constraints: string[];
  readonly rejected: string | null;
}

/**
 * Volatility-adjusted position sizing.
 *
 * The primary sizing rule is risk-based: we spend `riskPerTradePct` of equity to
 * find out whether the trade works, where "risk" is the distance from entry to
 * the stop. A tight stop buys more coins, a wide stop fewer, so every trade
 * loses roughly the same dollar amount when it is wrong. Every hard cap is then
 * applied on top, and the smallest one wins.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const { limits, product } = input;
  const constraints: string[] = [];

  const entry = D(input.entryPrice);
  const stop = D(input.stopPrice);
  const equity = D(input.equity);

  if (entry.lte(0)) return reject('entry price must be positive');
  if (stop.gte(entry)) return reject('stop price must be below entry price for a long');
  if (equity.lte(0)) return reject('equity is zero or negative');
  if (product.tradingDisabled) return reject(`trading disabled for ${product.productId}`);

  const riskPerUnit = entry.minus(stop);
  const riskBudget = equity.mul(limits.riskPerTradePct).div(100);

  // Confidence scales allocation over [0.5x, 1.0x]. A weak-but-valid signal gets
  // a smaller bet, never a bigger one than a strong signal.
  const confidence = Math.min(1, Math.max(0, input.confidence));
  const scaled = riskBudget.mul(0.5 + 0.5 * confidence);

  let size = scaled.div(riskPerUnit);
  constraints.push(`risk budget ${scaled.toFixed(2)} / ${riskPerUnit.toFixed(2)} per unit`);

  size = applyCap(size, D(limits.maxPositionNotional).div(entry), constraints, 'maxPositionNotional');

  const remainingBudget = D(limits.maxTotalNotional).minus(D(input.openNotional));
  if (remainingBudget.lte(0)) return reject('total notional cap already used');
  size = applyCap(size, remainingBudget.div(entry), constraints, 'maxTotalNotional');

  const affordable = D(input.availableQuote).div(entry);
  if (affordable.lte(0)) return reject('no quote balance available');
  size = applyCap(size, affordable, constraints, 'availableQuote');

  size = floorToIncrement(size, product.baseIncrement);
  if (size.lte(0)) {
    return reject(`size rounds to zero at base increment ${product.baseIncrement}`);
  }

  const notional = size.mul(entry);
  if (notional.lt(limits.minOrderNotional)) {
    return reject(
      `notional ${notional.toFixed(2)} below exchange minimum ${limits.minOrderNotional}`,
    );
  }
  if (notional.lt(product.minMarketFunds)) {
    return reject(`notional ${notional.toFixed(2)} below product minimum ${product.minMarketFunds}`);
  }

  return { baseSize: size, notional, constraints, rejected: null };

  function reject(why: string): SizingResult {
    return { baseSize: D(0), notional: D(0), constraints, rejected: why };
  }
}

function applyCap(size: Decimal, cap: Decimal, constraints: string[], label: string): Decimal {
  if (cap.lt(size)) {
    constraints.push(`capped by ${label}`);
    return cap;
  }
  return size;
}
