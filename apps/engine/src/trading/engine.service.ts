import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  D,
  Decimal,
  GRANULARITY_SECONDS,
  TaEnsembleStrategy,
  checkStops,
  openPosition,
  ratchetStop,
  sizePosition,
  type Candle,
  type ExitReason,
  type OrderIntent,
  type Signal,
  type StopConfig,
  type TaEnsembleConfig,
} from '@crypto-magic/core';
import type { ExchangeAdapter } from '@crypto-magic/exchange';
import { APP_CONFIG, STOP_CONFIG, STRATEGY_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { MarketDataService } from '../market-data/market-data.service';
import { EventRepository } from '../persistence/repositories/event.repository';
import { PositionRepository, type StoredPosition } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { childLogger } from '../common/logger';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { PortfolioService } from './portfolio.service';
import { ReconciliationService } from './reconciliation.service';
import { RiskService } from './risk.service';

const TICK_INTERVAL_NAME = 'trading-tick';
const LAST_BAR_KEY = (productId: string) => `last_bar:${productId}`;

/**
 * The loop.
 *
 * One timer drives two jobs at different cadences, which keeps them trivially
 * consistent with each other:
 *
 *   - Every tick (~30s): re-check open positions against the live ticker, so a
 *     stop is honoured in seconds rather than at the next hourly bar close.
 *   - On a new closed bar: run the strategy and possibly open or close.
 *
 * Strategy decisions only ever see CLOSED bars. Acting on a bar that is still
 * forming produces decisions that do not reproduce and do not survive to the
 * bar's close.
 */
@Injectable()
export class TradingEngineService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = childLogger('engine');
  private readonly strategy: TaEnsembleStrategy;
  private ticking = false;
  private started = false;
  /** When the last pass finished WITHOUT throwing. Liveness, not just uptime. */
  private lastTickCompletedAt: number | null = null;

  constructor(
    @Inject(EXCHANGE) private readonly exchange: ExchangeAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STOP_CONFIG) private readonly stopConfig: StopConfig,
    @Inject(STRATEGY_CONFIG) strategyConfig: TaEnsembleConfig,
    private readonly marketData: MarketDataService,
    private readonly positions: PositionRepository,
    private readonly trades: TradeRepository,
    private readonly state: StateRepository,
    private readonly events: EventRepository,
    private readonly portfolio: PortfolioService,
    private readonly risk: RiskService,
    private readonly executor: ExecutorService,
    private readonly killSwitch: KillSwitchService,
    private readonly reconciliation: ReconciliationService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.strategy = new TaEnsembleStrategy(strategyConfig);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.log.info(
      {
        mode: this.config.TRADING_MODE,
        live: this.exchange.isLive,
        exchange: this.exchange.name,
        products: this.config.PRODUCTS,
        granularity: this.config.GRANULARITY,
        strategy: this.strategy.name,
        warmupBars: this.strategy.warmupBars,
      },
      'starting trading engine',
    );
    this.events.append({
      level: 'info',
      kind: 'engine_started',
      message: `engine started in ${this.config.TRADING_MODE} mode`,
      data: { products: this.config.PRODUCTS, live: this.exchange.isLive },
    });

    try {
      await this.reconciliation.reconcile();
    } catch (error) {
      // Never begin trading on an unverified picture of our own holdings.
      this.log.error({ err: String(error) }, 'reconciliation failed');
      this.killSwitch.engage(`reconciliation failed at startup: ${String(error)}`);
    }

    const interval = setInterval(
      () => void this.tick(),
      this.config.STOP_MONITOR_INTERVAL_SECONDS * 1000,
    );
    this.scheduler.addInterval(TICK_INTERVAL_NAME, interval);
    this.started = true;

    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.started && this.scheduler.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(TICK_INTERVAL_NAME);
    }
    this.events.append({ level: 'info', kind: 'engine_stopped', message: 'engine stopped' });
  }

  get status() {
    return {
      mode: this.config.TRADING_MODE,
      live: this.exchange.isLive,
      exchange: this.exchange.name,
      strategy: this.strategy.name,
      products: this.config.PRODUCTS,
      granularity: this.config.GRANULARITY,
      killSwitchEngaged: this.killSwitch.isEngaged(),
      marketDataAgeSeconds: Number.isFinite(this.marketData.marketDataAgeSeconds)
        ? Math.round(this.marketData.marketDataAgeSeconds)
        : null,
      warmupBars: this.strategy.warmupBars,
      lastTickCompletedAt: this.lastTickCompletedAt,
    };
  }

  /** Null until the first pass completes. Read by the dead-man's switch. */
  get lastSuccessfulTickAt(): number | null {
    return this.lastTickCompletedAt;
  }

  /** One pass. Overlapping passes are skipped rather than queued. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.log.debug('previous tick still running; skipping');
      return;
    }
    this.ticking = true;
    try {
      await this.monitorStops();
      await this.processClosedBars();
      await this.portfolio.recordEquitySnapshot();
      this.lastTickCompletedAt = Date.now();
    } catch (error) {
      this.log.error({ err: String(error) }, 'tick failed');
      this.events.append({
        level: 'error',
        kind: 'error',
        message: `tick failed: ${String(error)}`,
      });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Check every open position against the live price.
   *
   * This runs far more often than the bar cadence on purpose: an hourly strategy
   * should still not take an hour to honour its own stop.
   */
  private async monitorStops(): Promise<void> {
    for (const position of this.positions.findAll()) {
      try {
        const ticker = await this.marketData.getTicker(position.productId);
        const price = D(ticker.price);

        const reason = checkStops({
          position,
          low: price,
          high: price,
          barsHeld: position.barsHeld,
          config: this.stopConfig,
        });

        if (reason) {
          this.log.warn(
            { productId: position.productId, price: price.toFixed(), stop: position.stopPrice.toFixed(), reason },
            'stop triggered',
          );
          await this.closePosition(position, reason, price);
          continue;
        }

        const ratcheted = ratchetStop(position, price, this.stopConfig);
        if (ratcheted !== position) {
          this.positions.upsert({ ...position, ...ratcheted });
        }
      } catch (error) {
        this.log.error(
          { productId: position.productId, err: String(error) },
          'failed to monitor position',
        );
      }
    }
  }

  /** Run the strategy once per product, per newly closed bar. */
  private async processClosedBars(): Promise<void> {
    for (const productId of this.config.PRODUCTS) {
      try {
        await this.processProduct(productId);
      } catch (error) {
        this.log.error({ productId, err: String(error) }, 'failed to process product');
        this.events.append({
          level: 'error',
          kind: 'error',
          message: `failed to process ${productId}: ${String(error)}`,
        });
      }
    }
  }

  private async processProduct(productId: string): Promise<void> {
    // Fetch the full lookback, not just warmup: the backtester evaluates every bar
    // on exactly this window, so live and backtest compute the same indicators.
    const fetched = await this.marketData.getRecentCandles(productId, this.strategy.lookbackBars);
    if (fetched.length < this.strategy.warmupBars) return;
    const candles = fetched.slice(-this.strategy.lookbackBars);

    const newest = candles.at(-1)!;
    const lastProcessed = Number(this.state.get(LAST_BAR_KEY(productId)) ?? 0);
    if (newest.openTime <= lastProcessed) return; // no new closed bar

    const position = this.positions.find(productId);
    if (position) {
      // Age the position in bars so the maximum-holding-period stop can fire.
      this.positions.upsert({ ...position, barsHeld: position.barsHeld + 1 });
    }

    const signal = this.strategy.evaluate({
      candles,
      position: position ?? null,
      now: newest.openTime + GRANULARITY_SECONDS[newest.granularity],
    });

    this.state.set(LAST_BAR_KEY(productId), String(newest.openTime));

    this.log.info(
      { productId, bar: newest.openTime, action: signal.action, confidence: signal.confidence },
      'evaluated closed bar',
    );

    if (signal.action === 'HOLD') return;

    this.events.append({
      level: 'info',
      kind: 'signal',
      message: `${signal.action} ${productId}: ${signal.reasons.join('; ')}`,
      data: { confidence: signal.confidence, indicators: signal.indicators },
    });

    if (signal.action === 'EXIT_LONG' && position) {
      await this.closePosition(position, signal.exitReason ?? 'signal', D(newest.close));
      return;
    }
    if (signal.action === 'ENTER_LONG' && !position) {
      await this.enterPosition(productId, candles, signal, newest);
    }
  }

  private async enterPosition(
    productId: string,
    candles: Candle[],
    signal: Signal,
    bar: Candle,
  ): Promise<void> {
    const atrValue = signal.indicators.atr;
    if (atrValue === null || atrValue === undefined || atrValue <= 0) {
      this.log.warn({ productId }, 'refusing entry: no usable ATR to place a stop against');
      return;
    }

    const product = await this.marketData.getProduct(productId);
    const ticker = await this.marketData.getTicker(productId);
    const referencePrice = D(ticker.price);

    // Size against the stop we would actually place, using the live price rather
    // than the bar close — the bar closed some seconds ago and the market moved.
    const provisional = openPosition({
      productId,
      baseSize: 1,
      entryPrice: referencePrice,
      atrValue,
      openedAt: bar.openTime,
      config: this.stopConfig,
    });

    const snapshot = await this.portfolio.snapshot();
    const openNotional = snapshot.positions.reduce(
      (sum, p) => sum.plus(p.baseSize.mul(p.averageEntryPrice)),
      D(0),
    );

    const sizing = sizePosition({
      equity: snapshot.equity,
      availableQuote: snapshot.cash,
      entryPrice: referencePrice,
      stopPrice: provisional.stopPrice,
      openNotional,
      product,
      limits: this.risk.limits,
      confidence: signal.confidence,
    });

    if (sizing.rejected) {
      this.log.info({ productId, reason: sizing.rejected }, 'sizer refused the entry');
      this.events.append({
        level: 'info',
        kind: 'risk_rejected',
        message: `sizer refused ${productId}: ${sizing.rejected}`,
      });
      return;
    }

    const intent: OrderIntent = {
      productId,
      side: 'BUY',
      baseSize: sizing.baseSize,
      referencePrice,
      reason: signal.reasons.join('; '),
      idempotencyKey: ExecutorService.idempotencyKey({
        mode: this.config.TRADING_MODE,
        productId,
        side: 'BUY',
        bar: bar.openTime,
        purpose: 'entry',
      }),
    };

    const { decision } = await this.risk.assess(intent);
    if (!decision.approved) {
      this.log.warn({ productId, rejections: decision.rejections }, 'risk engine refused the entry');
      this.events.append({
        level: 'warn',
        kind: 'risk_rejected',
        message: `risk refused ${productId}: ${decision.rejections.join('; ')}`,
      });
      return;
    }
    for (const warning of decision.warnings) this.log.warn({ productId }, warning);

    const result = await this.executor.execute({
      ...intent,
      ...(decision.adjustedBaseSize ? { baseSize: decision.adjustedBaseSize } : {}),
    });
    const order = result.order;
    if (!order || order.status !== 'FILLED' || order.filledSize.lte(0)) return;

    const entry = openPosition({
      productId,
      baseSize: order.filledSize,
      entryPrice: order.averageFillPrice,
      atrValue,
      openedAt: bar.openTime,
      config: this.stopConfig,
    });

    const stored: StoredPosition = {
      ...entry,
      barsHeld: 0,
      entryFee: order.fee,
      protectiveStopOrderId: null,
      entryReasons: signal.reasons,
      confidence: signal.confidence,
      mode: this.config.TRADING_MODE,
    };
    this.positions.upsert(stored);

    this.log.info(
      {
        productId,
        size: order.filledSize.toFixed(),
        entry: order.averageFillPrice.toFixed(),
        stop: entry.stopPrice.toFixed(),
        target: entry.takeProfitPrice?.toFixed() ?? null,
      },
      'position opened',
    );
    this.events.append({
      level: 'info',
      kind: 'position_opened',
      message: `opened ${productId} ${order.filledSize.toFixed()} @ ${order.averageFillPrice.toFixed()}`,
      data: { stop: entry.stopPrice.toFixed(), reasons: signal.reasons },
    });

    await this.placeProtectiveStop(stored);
  }

  /**
   * An exchange-side stop that outlives this process.
   *
   * It sits BELOW the engine's own stop by design. The engine should normally
   * win the race and exit at its tighter level; this one exists for the case
   * where the engine is not running at all, and a double exit would try to sell
   * coins we no longer hold.
   */
  private async placeProtectiveStop(position: StoredPosition): Promise<void> {
    if (!this.config.PROTECTIVE_STOP_ENABLED) return;
    if (!this.exchange.submitProtectiveStop) return;

    const slack = position.entryAtr.mul(this.config.PROTECTIVE_STOP_SLACK_ATR);
    const stopPrice = position.stopPrice.minus(slack);
    if (stopPrice.lte(0)) return;

    try {
      const order = await this.exchange.submitProtectiveStop({
        productId: position.productId,
        baseSize: position.baseSize,
        stopPrice,
        // Limit below the trigger so a fast move still has room to fill.
        limitPrice: stopPrice.mul(0.995),
        clientOrderId: ExecutorService.idempotencyKey({
          mode: this.config.TRADING_MODE,
          productId: position.productId,
          side: 'SELL',
          bar: position.openedAt,
          purpose: 'protstop',
        }),
      });
      this.positions.upsert({ ...position, protectiveStopOrderId: order.orderId });
      this.log.info(
        { productId: position.productId, stopPrice: stopPrice.toFixed(), orderId: order.orderId },
        'exchange-side protective stop placed',
      );
    } catch (error) {
      // Not fatal: the engine still enforces its own stop while it is running.
      this.log.error(
        { productId: position.productId, err: String(error) },
        'could not place the exchange-side protective stop; engine stop is now the only floor',
      );
    }
  }

  private async closePosition(
    position: StoredPosition,
    reason: ExitReason,
    referencePrice: Decimal,
  ): Promise<void> {
    // Cancel the exchange-side stop FIRST. Selling while it rests would leave a
    // stop order against coins we no longer hold.
    if (position.protectiveStopOrderId) {
      try {
        await this.exchange.cancelOrders([position.protectiveStopOrderId]);
      } catch (error) {
        this.log.warn(
          { productId: position.productId, err: String(error) },
          'could not cancel the protective stop before exiting',
        );
      }
    }

    const intent: OrderIntent = {
      productId: position.productId,
      side: 'SELL',
      baseSize: position.baseSize,
      referencePrice,
      reason: `exit: ${reason}`,
      exitReason: reason,
      idempotencyKey: ExecutorService.idempotencyKey({
        mode: this.config.TRADING_MODE,
        productId: position.productId,
        side: 'SELL',
        // Stop exits use the current minute, not the bar: a stop can legitimately
        // need a second attempt within one bar after a partial fill.
        bar: Math.floor(Date.now() / 60_000),
        purpose: reason,
      }),
    };

    const { decision } = await this.risk.assess(intent);
    const baseSize = decision.adjustedBaseSize ?? intent.baseSize;
    if (!decision.approved) {
      this.log.error(
        { productId: position.productId, rejections: decision.rejections },
        'risk engine refused an EXIT — this should not happen',
      );
      return;
    }

    const result = await this.executor.execute({ ...intent, baseSize });
    const order = result.order;
    if (!order || order.filledSize.lte(0)) {
      this.log.error(
        { productId: position.productId, skipped: result.skippedReason },
        'exit did not fill; position remains open',
      );
      return;
    }

    const proceeds = order.filledSize.mul(order.averageFillPrice);
    const costBasis = order.filledSize.mul(position.averageEntryPrice);
    // Apportion the entry fee to the fraction actually sold, so a partial exit
    // does not charge the whole entry cost against it.
    const soldFraction = position.baseSize.gt(0) ? order.filledSize.div(position.baseSize) : D(1);
    const fees = position.entryFee.mul(soldFraction).plus(order.fee);
    const pnl = proceeds.minus(costBasis).minus(fees);

    this.trades.insert({
      productId: position.productId,
      entryTime: position.openedAt * 1000,
      exitTime: Date.now(),
      entryPrice: position.averageEntryPrice,
      exitPrice: order.averageFillPrice,
      baseSize: order.filledSize,
      fees,
      pnl,
      pnlPct: costBasis.gt(0) ? pnl.div(costBasis).mul(100).toNumber() : 0,
      exitReason: reason,
      entryReasons: position.entryReasons,
      confidence: position.confidence,
      mode: this.config.TRADING_MODE,
      stopPrice: position.stopPrice,
      takeProfitPrice: position.takeProfitPrice,
    });

    const remaining = position.baseSize.minus(order.filledSize);
    if (remaining.gt(0)) {
      this.log.warn(
        { productId: position.productId, remaining: remaining.toFixed() },
        'exit filled only partially; keeping the remainder open',
      );
      this.positions.upsert({ ...position, baseSize: remaining, entryFee: position.entryFee.mul(D(1).minus(soldFraction)) });
    } else {
      this.positions.remove(position.productId);
    }

    this.log.info(
      {
        productId: position.productId,
        reason,
        pnl: pnl.toFixed(2),
        exit: order.averageFillPrice.toFixed(),
      },
      'position closed',
    );
    this.events.append({
      level: pnl.gte(0) ? 'info' : 'warn',
      kind: 'position_closed',
      message: `closed ${position.productId} (${reason}) P&L ${pnl.toFixed(2)}`,
      data: { pnl: pnl.toFixed(), fees: fees.toFixed(), exitPrice: order.averageFillPrice.toFixed() },
    });
  }

  /** Flatten everything at market. Used by the dashboard's panic button. */
  async flattenAll(reason: ExitReason = 'manual'): Promise<number> {
    const open = this.positions.findAll();
    let closed = 0;
    for (const position of open) {
      const ticker = await this.marketData.getTicker(position.productId);
      await this.closePosition(position, reason, D(ticker.price));
      closed++;
    }
    return closed;
  }
}
