import { Inject, Injectable } from '@nestjs/common';
import {
  RiskEngine,
  type OrderIntent,
  type RiskDecision,
  type RiskLimits,
  type RiskState,
} from '@crypto-magic/core';
import { APP_CONFIG, RISK_LIMITS } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { MarketDataService } from '../market-data/market-data.service';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { KillSwitchService } from './kill-switch.service';
import { PortfolioService } from './portfolio.service';

const ONE_HOUR_MS = 3_600_000;

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

  constructor(
    @Inject(RISK_LIMITS) limits: RiskLimits,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly portfolio: PortfolioService,
    private readonly orders: OrderRepository,
    private readonly trades: TradeRepository,
    private readonly killSwitch: KillSwitchService,
    private readonly marketData: MarketDataService,
  ) {
    this.engine = new RiskEngine(limits);
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
      consecutiveLosses: this.trades.consecutiveLosses(),
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

  checkSlippage(referencePrice: Parameters<RiskEngine['checkSlippage']>[0], fillPrice: Parameters<RiskEngine['checkSlippage']>[1]) {
    return this.engine.checkSlippage(referencePrice, fillPrice);
  }

  async haltReasons() {
    return this.engine.haltReasons(await this.currentState());
  }
}
