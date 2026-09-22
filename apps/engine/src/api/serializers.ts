import { Decimal } from '@crypto-magic/core';

/**
 * Decimals cross the wire as strings, never as JSON numbers.
 *
 * `JSON.stringify` on a Decimal yields its object form, and coercing to a
 * number reintroduces exactly the float imprecision the Decimal was chosen to
 * avoid. The dashboard parses these for display only.
 */
export function serialize<T>(value: T): unknown {
  if (value instanceof Decimal) return value.toFixed();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serialize(v)]),
    );
  }
  return value;
}
