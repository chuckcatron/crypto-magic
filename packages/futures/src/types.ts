/**
 * Domain types for trading perpetual-style futures in both directions.
 *
 * Everything here is pure and shared by the backtest and the paper engine, so
 * the paper bot runs exactly the rules that were tested
 * (docs/EXPERIMENT-008-fast-futures.md).
 */

/** A closed bar. `t` is the UNIX second at which it opened. */
export interface Bar {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

export type Direction = 'LONG' | 'SHORT';

/** +1 for a long, -1 for a short: the sign of P&L per unit of price move. */
export function sign(direction: Direction): 1 | -1 {
  return direction === 'LONG' ? 1 : -1;
}

/**
 * What a strategy asks for at a bar's close. It fills at the next bar's open,
 * and the distances are measured from that fill, not from the close.
 */
export interface EntrySignal {
  readonly direction: Direction;
  /** Price distance from the fill to the stop. Positive. */
  readonly stopDistance: number;
  /** Price distance from the fill to the target. Positive. */
  readonly targetDistance: number;
  readonly maxHoldSeconds: number;
  /** Human-readable why, kept with the trade. */
  readonly reason: string;
}

export type ExitReason = 'stop' | 'target' | 'time' | 'end' | 'rebalance';

export interface OpenPosition {
  readonly direction: Direction;
  readonly entryTime: number;
  readonly entryPrice: number;
  /** Base units, fractional. */
  readonly size: number;
  readonly stop: number;
  readonly target: number;
  /** Time stop: exit at the open of the first bar that opens at or after this. */
  readonly deadline: number;
  readonly entryFee: number;
  /** Account equity just before the entry, for return-on-equity. */
  readonly equityAtEntry: number;
  readonly reason: string;
}

export interface ClosedTrade {
  readonly productId: string;
  readonly direction: Direction;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly size: number;
  /** Price P&L before costs. */
  readonly grossPnl: number;
  readonly fees: number;
  readonly funding: number;
  readonly netPnl: number;
  /** Net P&L as a fraction of the account's equity at entry. */
  readonly returnOnEquity: number;
  readonly exitReason: ExitReason;
  readonly reason: string;
}

export interface CostModel {
  /** All-in cost of every fill (fee, spread, slippage), in bps of notional. */
  readonly fillBps: number;
  /** Funding charged on every open position, long or short, in bps of notional per hour. */
  readonly fundingBpsPerHour: number;
}

/** EXPERIMENT-008's base costs. */
export const BASE_COSTS: CostModel = { fillBps: 8, fundingBpsPerHour: 0.15 };
/** EXPERIMENT-008's stress costs: every fill twice as expensive. */
export const STRESS_COSTS: CostModel = { fillBps: 16, fundingBpsPerHour: 0.15 };

export interface RiskRules {
  /** Fraction of equity lost if the stop is hit (before costs). */
  readonly riskPerTrade: number;
  /** Position notional as a multiple of equity, at most. */
  readonly maxLeverage: number;
  /** Realized loss, as a fraction of the day's opening equity, that halts new entries. */
  readonly dailyLossLimit: number;
}

/** The risk rules EXPERIMENT-008 tests. Not tuning knobs. */
export const RISK_RULES: RiskRules = { riskPerTrade: 0.005, maxLeverage: 1, dailyLossLimit: 0.02 };

/** Equity at the close of a UTC day. `day` is that day's 00:00 UTC, in UNIX seconds. */
export interface DailyMark {
  readonly day: number;
  readonly equity: number;
}

export const FIVE_MINUTES = 300;
export const FIFTEEN_MINUTES = 900;
export const FOUR_HOURS = 14_400;
export const DAY = 86_400;

export function utcDay(t: number): number {
  return Math.floor(t / DAY) * DAY;
}
