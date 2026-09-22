import { D, Decimal, type Numeric } from '../money';
import type { OrderIntent, Position } from '../types/trading';
import type { RiskLimits } from './limits';
import { validateRiskLimits } from './limits';

export type HaltReason =
  | 'kill_switch'
  | 'daily_loss_limit'
  | 'consecutive_losses'
  | 'order_rate_limit'
  | 'stale_market_data'
  | 'exchange_unreachable'
  | 'reconciliation_mismatch';

export interface RiskState {
  readonly equity: Numeric;
  readonly availableQuote: Numeric;
  readonly openPositions: readonly Position[];
  /** Realized P&L for the current UTC day, in quote currency. */
  readonly realizedPnlToday: Numeric;
  readonly consecutiveLosses: number;
  /** Order submissions in the trailing hour. */
  readonly ordersLastHour: number;
  readonly killSwitchEngaged: boolean;
  /** Seconds since the newest market data we hold. */
  readonly marketDataAgeSeconds: number;
  /** Maximum tolerable market data age before we stop trusting our prices. */
  readonly maxMarketDataAgeSeconds: number;
}

export interface RiskDecision {
  readonly approved: boolean;
  /** Present when approved and the engine shrank the order. */
  readonly adjustedBaseSize: Decimal | null;
  readonly rejections: string[];
  readonly warnings: string[];
}

/**
 * The last gate before an order reaches the exchange.
 *
 * Two rules shape everything here:
 *   1. Exits are never blocked. A halt that traps us in a losing position is
 *      worse than the condition that caused the halt.
 *   2. Entries must satisfy every cap. Any single failure rejects the order.
 */
export class RiskEngine {
  constructor(private readonly limits: RiskLimits) {
    validateRiskLimits(limits);
  }

  get currentLimits(): RiskLimits {
    return this.limits;
  }

  /** Conditions that stop new entries. Exits are unaffected. */
  haltReasons(state: RiskState): HaltReason[] {
    const halts: HaltReason[] = [];
    if (state.killSwitchEngaged) halts.push('kill_switch');
    if (D(state.realizedPnlToday).lte(-this.limits.maxDailyLoss)) halts.push('daily_loss_limit');
    if (state.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      halts.push('consecutive_losses');
    }
    if (state.ordersLastHour >= this.limits.maxOrdersPerHour) halts.push('order_rate_limit');
    if (state.marketDataAgeSeconds > state.maxMarketDataAgeSeconds) halts.push('stale_market_data');
    return halts;
  }

  assess(intent: OrderIntent, state: RiskState): RiskDecision {
    return intent.side === 'SELL' ? this.assessExit(intent, state) : this.assessEntry(intent, state);
  }

  /**
   * Sells are reducing-only in a spot long-only system, so they can only ever
   * lower risk. The single check is that we actually hold what we're selling.
   */
  private assessExit(intent: OrderIntent, state: RiskState): RiskDecision {
    const held = state.openPositions.find((p) => p.productId === intent.productId);
    if (!held) {
      return fail([`no open position in ${intent.productId} to sell`]);
    }
    if (intent.baseSize.gt(held.baseSize)) {
      return {
        approved: true,
        adjustedBaseSize: held.baseSize,
        rejections: [],
        warnings: [
          `sell size ${intent.baseSize.toFixed()} exceeds held ${held.baseSize.toFixed()}; reduced to holdings`,
        ],
      };
    }
    return { approved: true, adjustedBaseSize: null, rejections: [], warnings: [] };
  }

  private assessEntry(intent: OrderIntent, state: RiskState): RiskDecision {
    const rejections: string[] = [];
    const warnings: string[] = [];

    for (const halt of this.haltReasons(state)) {
      rejections.push(`trading halted: ${halt}`);
    }

    if (state.openPositions.some((p) => p.productId === intent.productId)) {
      rejections.push(`already holding ${intent.productId}; this strategy does not scale in`);
    }
    if (state.openPositions.length >= this.limits.maxOpenPositions) {
      rejections.push(
        `open positions ${state.openPositions.length} at cap ${this.limits.maxOpenPositions}`,
      );
    }

    const price = intent.referencePrice;
    if (price.lte(0)) rejections.push('reference price is not positive');

    const notional = intent.baseSize.mul(price);
    if (notional.gt(this.limits.maxPositionNotional)) {
      rejections.push(
        `notional ${notional.toFixed(2)} exceeds per-position cap ${this.limits.maxPositionNotional}`,
      );
    }
    if (notional.lt(this.limits.minOrderNotional)) {
      rejections.push(
        `notional ${notional.toFixed(2)} below minimum ${this.limits.minOrderNotional}`,
      );
    }

    const openNotional = totalNotional(state.openPositions);
    if (openNotional.plus(notional).gt(this.limits.maxTotalNotional)) {
      rejections.push(
        `total notional ${openNotional.plus(notional).toFixed(2)} would exceed cap ${this.limits.maxTotalNotional}`,
      );
    }
    if (notional.gt(D(state.availableQuote))) {
      rejections.push(
        `notional ${notional.toFixed(2)} exceeds available quote ${D(state.availableQuote).toFixed(2)}`,
      );
    }

    const remainingDailyLoss = D(this.limits.maxDailyLoss).plus(D(state.realizedPnlToday));
    if (remainingDailyLoss.lt(this.limits.maxDailyLoss * 0.25)) {
      warnings.push(
        `only ${remainingDailyLoss.toFixed(2)} of the daily loss budget remains`,
      );
    }

    if (rejections.length > 0) return fail(rejections, warnings);
    return { approved: true, adjustedBaseSize: null, rejections: [], warnings };
  }

  /**
   * Post-trade slippage check. A fill far from the reference price means the
   * book moved or we mispriced; the caller should halt and reconcile rather
   * than keep firing orders into it.
   */
  checkSlippage(referencePrice: Numeric, fillPrice: Numeric): { ok: boolean; pct: number } {
    const ref = D(referencePrice);
    if (ref.lte(0)) return { ok: false, pct: Number.POSITIVE_INFINITY };
    const pct = D(fillPrice).minus(ref).div(ref).mul(100).abs().toNumber();
    return { ok: pct <= this.limits.maxSlippagePct, pct };
  }
}

export function totalNotional(positions: readonly Position[]): Decimal {
  return positions.reduce((sum, p) => sum.plus(p.baseSize.mul(p.averageEntryPrice)), D(0));
}

function fail(rejections: string[], warnings: string[] = []): RiskDecision {
  return { approved: false, adjustedBaseSize: null, rejections, warnings };
}
