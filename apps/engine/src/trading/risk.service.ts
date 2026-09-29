import { Inject, Injectable } from '@nestjs/common';
import {
  D,
  RiskEngine,
  type HaltReason,
  type OrderIntent,
  type RiskDecision,
  type RiskLimits,
  type RiskState,
} from '@crypto-magic/core';
import { APP_CONFIG, RISK_LIMITS } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { MarketDataService } from '../market-data/market-data.service';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { KillSwitchService } from './kill-switch.service';
import { PortfolioService } from './portfolio.service';

const ONE_HOUR_MS = 3_600_000;

/** When the operator last reset the losing streak (ms). Losses before it no longer count. */
export const LOSS_STREAK_RESET_KEY = 'risk:loss_streak_reset_at';

/**
 * The halts that begin when a trade closes, and so are announced then. The
 * others either announce themselves (the kill switch) or clear on their own
 * within minutes (stale data, the hourly order limit).
 */
const ANNOUNCED_HALTS: readonly HaltReason[] = ['consecutive_losses', 'daily_loss_limit'];

/** Start of the current UTC day. The daily loss budget resets here. */
function startOfUtcDay(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Assembles the live picture the RiskEngine needs, then defers to it.
 *
 * All the actual rules live in the core RiskEngine so they are covered by unit
 * tests and shared with the backtester. This class only gathers facts.
 */
@Injectable()
export class RiskService {
  private readonly engine: RiskEngine;

  /** Halts already announced, so each one alerts once, not on every trade. */
  private readonly announced = new Set<HaltReason>();

  constructor(
    @Inject(RISK_LIMITS) limits: RiskLimits,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly portfolio: PortfolioService,
    private readonly orders: OrderRepository,
    private readonly trades: TradeRepository,
    private readonly killSwitch: KillSwitchService,
    private readonly marketData: MarketDataService,
    private readonly state: StateRepository,
    private readonly events: EventRepository,
  ) {
    this.engine = new RiskEngine(limits);
  }

  /** Losing trades in a row since the last reset. */
  lossStreak(): number {
    return this.trades.consecutiveLosses(this.lossStreakResetAt());
  }

  private lossStreakResetAt(): number {
    return Number(this.state.get(LOSS_STREAK_RESET_KEY) ?? 0);
  }

  /**
   * Forget the current losing streak, so entries can resume.
   *
   * The consecutive-loss halt cannot end by itself: only a winning trade breaks
   * a streak, and the halt blocks the entries that could produce one. This is
   * the operator's way out after reviewing the trades. Past trades are not
   * touched; only losses from now on count toward the next halt.
   */
  resetLossStreak(): { cleared: number } {
    const cleared = this.lossStreak();
    this.state.set(LOSS_STREAK_RESET_KEY, String(Date.now()));
    this.announced.delete('consecutive_losses');
    this.events.append({
      level: 'info',
      kind: 'halt',
      message: `losing streak reset by the operator after ${cleared} loss(es); entries allowed again`,
      data: { cleared },
    });
    return { cleared };
  }

  /**
   * Record, once each, the halts that just began, so they alert.
   *
   * Called after every closed trade and at startup. A halt that clears (a new
   * UTC day, a reset) may be announced again if it recurs.
   */
  async announceHalts(): Promise<HaltReason[]> {
    const state = await this.currentState();
    const active = this.engine.haltReasons(state).filter((h) => ANNOUNCED_HALTS.includes(h));
    for (const reason of [...this.announced]) {
      if (!active.includes(reason)) this.announced.delete(reason);
    }
    const started = active.filter((h) => !this.announced.has(h));
    for (const reason of started) {
      this.announced.add(reason);
      this.events.append({
        level: 'error',
        kind: 'halt',
        message: this.describeHalt(reason, state),
        data: { reason },
      });
    }
    return started;
  }

  private describeHalt(reason: HaltReason, state: RiskState): string {
    const { maxConsecutiveLosses, maxDailyLoss } = this.engine.currentLimits;
    if (reason === 'consecutive_losses') {
      return (
        `new entries halted: ${state.consecutiveLosses} losing trades in a row (limit ${maxConsecutiveLosses}). ` +
        'Exits still run. This does not clear by itself: review the trades, then run `cm reset-streak` ' +
        '(or use the dashboard), or raise MAX_CONSECUTIVE_LOSSES.'
      );
    }
    return (
      `new entries halted until 00:00 UTC: realized loss today ${D(state.realizedPnlToday).abs().toFixed(2)} ` +
      `reached MAX_DAILY_LOSS ${maxDailyLoss}. Exits still run.`
    );
  }

  get limits(): RiskLimits {
    return this.engine.currentLimits;
  }

  async currentState(): Promise<RiskState> {
    const snapshot = await this.portfolio.snapshot();
    return {
      equity: snapshot.equity,
      availableQuote: snapshot.cash,
      openPositions: snapshot.positions,
      realizedPnlToday: this.trades.realizedPnlSince(startOfUtcDay()),
      consecutiveLosses: this.lossStreak(),
      ordersLastHour: this.orders.countSince(Date.now() - ONE_HOUR_MS),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      marketDataAgeSeconds: this.marketData.marketDataAgeSeconds,
      maxMarketDataAgeSeconds: this.marketData.maxMarketDataAgeSeconds,
    };
  }

  async assess(intent: OrderIntent): Promise<{ decision: RiskDecision; state: RiskState }> {
    const state = await this.currentState();
    return { decision: this.engine.assess(intent, state), state };
  }

  checkSlippage(
    referencePrice: Parameters<RiskEngine['checkSlippage']>[0],
    fillPrice: Parameters<RiskEngine['checkSlippage']>[1],
  ) {
    return this.engine.checkSlippage(referencePrice, fillPrice);
  }

  async haltReasons() {
    return this.engine.haltReasons(await this.currentState());
  }
}
