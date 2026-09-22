import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { D } from '@crypto-magic/core';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeAnalysisRepository } from '../persistence/repositories/trade-analysis.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { PostMortemService } from '../insight/postmortem.service';
import { TradingEngineService } from '../trading/engine.service';
import { KillSwitchService } from '../trading/kill-switch.service';
import { PortfolioService } from '../trading/portfolio.service';
import { RiskService } from '../trading/risk.service';
import { serialize } from './serializers';

const clampLimit = (value: string | undefined, fallback: number, max: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

/**
 * Read-only dashboard API plus three controls.
 *
 * Binds to localhost only (see main.ts). There is no authentication because
 * there is no remote surface — if this ever needs to be reachable off-box, it
 * needs auth first.
 */
@Controller('api')
export class ApiController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly engine: TradingEngineService,
    private readonly portfolio: PortfolioService,
    private readonly positions: PositionRepository,
    private readonly trades: TradeRepository,
    private readonly analyses: TradeAnalysisRepository,
    private readonly postMortems: PostMortemService,
    private readonly orders: OrderRepository,
    private readonly events: EventRepository,
    private readonly state: StateRepository,
    private readonly risk: RiskService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  @Get('status')
  async status() {
    return serialize({
      ...this.engine.status,
      limits: this.risk.limits,
      haltReasons: await this.risk.haltReasons(),
      serverTime: Date.now(),
    });
  }

  @Get('portfolio')
  async portfolioSnapshot() {
    const snapshot = await this.portfolio.snapshot();
    return serialize(snapshot);
  }

  @Get('positions')
  listPositions() {
    return serialize(this.positions.findAll());
  }

  /** Trades, each with its post-mortem attached when one has been written. */
  @Get('trades')
  listTrades(@Query('limit') limit?: string) {
    const trades = this.trades.recent(clampLimit(limit, 100, 1000));
    const byTradeId = this.analyses.findMany(
      trades.map((t) => t.id).filter((id): id is number => id !== undefined),
    );
    return serialize(
      trades.map((trade) => ({
        ...trade,
        analysis: trade.id === undefined ? null : (byTradeId.get(trade.id) ?? null),
      })),
    );
  }

  @Get('insight')
  insightStatus() {
    return serialize(this.postMortems.status);
  }

  @Get('orders')
  listOrders(@Query('limit') limit?: string) {
    return serialize(this.orders.recent(clampLimit(limit, 50, 500)));
  }

  @Get('events')
  listEvents(@Query('limit') limit?: string) {
    return serialize(this.events.recent(clampLimit(limit, 200, 1000)));
  }

  @Get('equity')
  equityCurve(@Query('limit') limit?: string) {
    return serialize(this.state.equityCurve(clampLimit(limit, 1000, 5000)));
  }

  /** Realized performance so far. Deliberately the same shape as a backtest's metrics. */
  @Get('metrics')
  metrics() {
    const trades = this.trades.all();
    const wins = trades.filter((t) => t.pnl.gt(0));
    const losses = trades.filter((t) => t.pnl.lte(0));
    const grossProfit = wins.reduce((s, t) => s.plus(t.pnl), D(0));
    const grossLoss = losses.reduce((s, t) => s.plus(t.pnl), D(0)).abs();

    return serialize({
      totalTrades: trades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      realizedPnl: trades.reduce((s, t) => s.plus(t.pnl), D(0)),
      totalFees: trades.reduce((s, t) => s.plus(t.fees), D(0)),
      grossProfit,
      grossLoss,
      profitFactor: grossLoss.gt(0) ? grossProfit.div(grossLoss).toNumber() : null,
      averageWin: wins.length > 0 ? grossProfit.div(wins.length) : D(0),
      averageLoss: losses.length > 0 ? grossLoss.div(losses.length).neg() : D(0),
      byExitReason: countBy(trades.map((t) => t.exitReason)),
    });
  }

  @Get('config')
  safeConfig() {
    // Credentials are never exposed, not even redacted placeholders.
    const { COINBASE_API_KEY_NAME, COINBASE_API_PRIVATE_KEY, LIVE_TRADING_ACK, ...safe } =
      this.config;
    return serialize(safe);
  }

  @Post('kill-switch/engage')
  engage(@Body() body: { reason?: string }) {
    this.killSwitch.engage(body?.reason?.slice(0, 500) || 'engaged from the dashboard');
    return { engaged: true };
  }

  @Post('kill-switch/release')
  release() {
    this.killSwitch.release();
    return { engaged: false };
  }

  /** Panic button: sell everything at market, now. */
  @Post('flatten')
  async flatten() {
    const closed = await this.engine.flattenAll('manual');
    return { closed };
  }
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}
