import Decimal from 'decimal.js';

// Money and sizes are never floats. Every quantity that can turn into an order
// goes through Decimal so rounding is explicit and auditable.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type Numeric = Decimal | number | string;

export const D = (v: Numeric): Decimal => (v instanceof Decimal ? v : new Decimal(v));

export const ZERO = new Decimal(0);

/**
 * Round a base size DOWN to the exchange's increment. Always down: rounding a
 * sell up can try to sell more than we hold, and rounding a buy up can breach a
 * notional cap.
 */
export function floorToIncrement(value: Numeric, increment: Numeric): Decimal {
  const inc = D(increment);
  if (inc.lte(0)) return D(value);
  return D(value).div(inc).floor().mul(inc);
}

/** Round a price to the exchange's quote increment, toward `side`'s safe direction. */
export function roundPrice(value: Numeric, increment: Numeric, direction: 'up' | 'down'): Decimal {
  const inc = D(increment);
  if (inc.lte(0)) return D(value);
  const n = D(value).div(inc);
  return (direction === 'up' ? n.ceil() : n.floor()).mul(inc);
}

/** Decimal places implied by an increment string like "0.00000001" -> 8. */
export function precisionOf(increment: Numeric): number {
  const s = D(increment).toFixed();
  const dot = s.indexOf('.');
  if (dot === -1) return 0;
  return s.length - dot - 1;
}

/** Format for the Coinbase API, which takes sizes and prices as plain strings. */
export function toApiString(value: Numeric, increment: Numeric): string {
  return D(value).toFixed(precisionOf(increment));
}

export { Decimal };
