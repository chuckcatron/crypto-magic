/**
 * Hard caps. These are enforced by the risk engine on every single order and are
 * deliberately independent of the strategy — a bug in strategy code must not be
 * able to spend more than these allow.
 */
export interface RiskLimits {
  /** Ceiling on the sum of all open position values, in quote currency. */
  readonly maxTotalNotional: number;
  /** Ceiling on any single position's value, in quote currency. */
  readonly maxPositionNotional: number;
  readonly maxOpenPositions: number;
  /** Fraction of equity risked between entry and stop, as a percent. */
  readonly riskPerTradePct: number;
  /** Realized loss in one UTC day that halts new entries. */
  readonly maxDailyLoss: number;
  /** Losing trades in a row that halt new entries. */
  readonly maxConsecutiveLosses: number;
  /** Rate limit on order submissions — a runaway loop's blast radius. */
  readonly maxOrdersPerHour: number;
  /** Reject a fill whose price differs from the reference by more than this percent. */
  readonly maxSlippagePct: number;
  /** Exchange minimum order value in quote currency. */
  readonly minOrderNotional: number;
}

/**
 * Conservative starting point for a live account. Sized so a total loss is an
 * annoyance rather than an event.
 */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxTotalNotional: 100,
  maxPositionNotional: 25,
  maxOpenPositions: 4,
  riskPerTradePct: 1,
  maxDailyLoss: 10,
  maxConsecutiveLosses: 4,
  maxOrdersPerHour: 12,
  maxSlippagePct: 0.5,
  minOrderNotional: 1,
};

export function validateRiskLimits(l: RiskLimits): void {
  const positive: (keyof RiskLimits)[] = [
    'maxTotalNotional',
    'maxPositionNotional',
    'riskPerTradePct',
    'maxDailyLoss',
    'maxSlippagePct',
    'minOrderNotional',
  ];
  for (const key of positive) {
    const value = l[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`risk limit ${key} must be a positive finite number, got ${value}`);
    }
  }
  if (l.maxPositionNotional > l.maxTotalNotional) {
    throw new RangeError('maxPositionNotional cannot exceed maxTotalNotional');
  }
  if (l.minOrderNotional > l.maxPositionNotional) {
    throw new RangeError('minOrderNotional cannot exceed maxPositionNotional — no order could ever pass');
  }
  if (!Number.isInteger(l.maxOpenPositions) || l.maxOpenPositions < 1) {
    throw new RangeError('maxOpenPositions must be a positive integer');
  }
  if (!Number.isInteger(l.maxOrdersPerHour) || l.maxOrdersPerHour < 1) {
    throw new RangeError('maxOrdersPerHour must be a positive integer');
  }
  if (l.riskPerTradePct > 100) {
    throw new RangeError('riskPerTradePct above 100 would risk more than the account holds');
  }
}
