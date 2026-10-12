import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  D,
  Decimal,
  GRANULARITY_SECONDS,
  checkStops,
  openPosition,
  ratchetStop,
  sizePosition,
  type Candle,
  type ExitReason,
  type OrderIntent,
  type Granularity,
  type Signal,
  type StopConfig,
  type Strategy,
} from '@crypto-magic/core';
import type { ExchangeAdapter, OrderResult } from '@crypto-magic/exchange';
import { APP_CONFIG, STOP_CONFIG, STRATEGY } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { MarketDataService } from '../market-data/market-data.service';
import type { Db } from '../persistence/database';
import { DATABASE } from '../persistence/tokens';
import { EventRepository } from '../persistence/repositories/event.repository';
import {
  PositionRepository,
  type StoredPosition,
} from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { childLogger } from '../common/logger';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { MakerOrderService, type WorkingOutcome } from './maker-order.service';
import { PortfolioService } from './portfolio.service';
import { ReconciliationService } from './reconciliation.service';
import { RiskService } from './risk.service';

/** What one or more orders filled, together. */
interface FillTotal {
  readonly size: Decimal;
  readonly price: Decimal;
  readonly fee: Decimal;
}

/** Add up fills: total size, size-weighted price, total fee. Null if nothing filled. */
function combineFills(orders: readonly OrderResult[]): FillTotal | null {
  const filled = orders.filter((o) => o.filledSize.gt(0));
  if (filled.length === 0) return null;
  const size = filled.reduce((sum, o) => sum.plus(o.filledSize), D(0));
  const cost = filled.reduce((sum, o) => sum.plus(o.filledSize.mul(o.averageFillPrice)), D(0));
  const fee = filled.reduce((sum, o) => sum.plus(o.fee), D(0));
  return { size, price: cost.div(size), fee };
}

const TICK_INTERVAL_NAME = 'trading-tick';
/**
 * The newest bar already acted on, per product AND bar size. One key for all
 * sizes would compare a daily bar's open time against an hourly one: after
 * switching hourly -> daily, every daily bar looks older than the last hourly
 * bar and the engine silently skips a day.
 */
const LAST_BAR_KEY = (productId: string, granularity: Granularity) =>
  `last_bar:${productId}:${granularity}`;
/**
 * The key before bar size was part of it. Every run until then was hourly (the
 * default, and the only size ta-ensemble shipped with), so it is read as the
 * hourly value and never for any other size.
 */
const LEGACY_LAST_BAR_KEY = (productId: string) => `last_bar:${productId}`;
/** Strategy the engine last started with; see guardStrategySwitch(). */
const STRATEGY_KEY = 'strategy';
/** The only strategy that existed before STRATEGY_KEY was recorded. */
const STRATEGY_BEFORE_SELECTION = 'ta-ensemble-v1';

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
  private ticking = false;
  private started = false;
  /** When the last pass finished WITHOUT throwing. Liveness, not just uptime. */
  private lastTickCompletedAt: number | null = null;

  constructor(
    @Inject(EXCHANGE) private readonly exchange: ExchangeAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STOP_CONFIG) private readonly stopConfig: StopConfig,
    @Inject(STRATEGY) private readonly strategy: Strategy,
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
    private readonly maker: MakerOrderService,
    @Inject(DATABASE) private readonly db: Db,
  ) {}

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

    this.guardStrategySwitch();
    // A bot restarted while halted says so, rather than blocking entries silently.
    await this.announceHalts();

    const interval = setInterval(
      () => void this.tick(),
      this.config.STOP_MONITOR_INTERVAL_SECONDS * 1000,
    );
    this.scheduler.addInterval(TICK_INTERVAL_NAME, interval);
    this.started = true;

    void this.tick();
  }

  /**
   * Refuse to let a new strategy inherit positions an old one opened.
   *
   * A position carries the stop and exit logic of the strategy that opened it.
   * Handing it to a different one (ta-ensemble's 2-ATR stop under the regime
   * filter's rules, or the reverse) manages it by rules nobody chose. So when
   * the strategy changed and positions are open, engage the kill switch and
   * say why; flatten, then restart. The new name is only recorded once no
   * position is open, so every restart re-checks until the switch is clean.
   */
  private guardStrategySwitch(): void {
    const current = this.strategy.name;
    const recorded = this.state.get(STRATEGY_KEY);
    const open = this.positions.findAll();

    if (recorded === null && open.length === 0) {
      // Fresh install, or an upgrade while flat: nothing to protect.
      this.state.set(STRATEGY_KEY, current);
      return;
    }
    // Positions from before the strategy was recorded were opened by the only
    // strategy that existed then.
    const previous = recorded ?? STRATEGY_BEFORE_SELECTION;
    if (previous === current) {
      if (recorded === null) this.state.set(STRATEGY_KEY, current);
      return;
    }

    if (open.length > 0) {
      const products = open.map((p) => p.productId).join(', ');
      this.killSwitch.engage(
        `strategy changed from ${previous} to ${current} with open positions (${products}). ` +
          'Flatten them, then restart, so no position is managed by rules it was not opened under.',
      );
      return;
    }
    this.state.set(STRATEGY_KEY, current);
    this.events.append({
      level: 'info',
      kind: 'strategy_changed',
      message: `strategy changed from ${previous} to ${current}`,
    });
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
      makerOrders: this.maker.enabled,
      workingOrders: this.maker.list().map((w) => ({
        productId: w.productId,
        purpose: w.purpose,
        side: w.side,
        baseSize: w.baseSize,
        limitPrice: w.limitPrice,
        expiresAt: w.expiresAt,
      })),
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
      // After the bars: a market order for what a maker order left needs fresh
      // market data, and after a restart nothing has been fetched before this.
      await this.progressWorkingOrders();
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

  /** Move each maker order along, and book those that finished (MakerOrderService). */
  private async progressWorkingOrders(): Promise<void> {
    for (const working of this.maker.list()) {
      try {
        const outcome = await this.maker.advance(working);
        if (outcome) await this.complete(outcome);
      } catch (error) {
        this.log.error(
          { productId: working.productId, err: String(error) },
          'failed to advance a maker order',
        );
        this.events.append({
          level: 'error',
          kind: 'error',
          message: `failed to advance the maker order for ${working.productId}: ${String(error)}`,
        });
      }
    }
  }

  /**
   * Book a finished maker order: open the position its entry bought, or record
   * the trade its exit sold. That and retiring the working order are one
   * transaction, so a crash can neither lose the fills nor book them twice.
   */
  private async complete({ working, fills }: WorkingOutcome): Promise<void> {
    const fill = combineFills(fills);
    const opened = this.db.transaction((): StoredPosition | null => {
      this.maker.retire(working.productId);
      if (!fill) return null;
      if (working.purpose === 'exit') {
        const position = this.positions.find(working.productId);
        if (position) this.bookExit(position, working.exitReason ?? 'signal', fill);
        else
          this.log.error(
            { productId: working.productId },
            'maker exit filled with no position to book it against',
          );
        return null;
      }
      if (this.positions.find(working.productId)) {
        this.log.error(
          { productId: working.productId },
          'maker entry filled while a position was already open; not overwriting it',
        );
        return null;
      }
      return this.openFromFills({
        productId: working.productId,
        fill,
        atr: working.entryAtr ?? D(0),
        openedAt: working.barOpenTime,
        reasons: working.entryReasons,
        confidence: working.confidence,
      });
    })();

    if (!fill) {
      this.events.append({
        level: 'info',
        kind: 'order_submitted',
        message: `the ${working.purpose} for ${working.productId} ended with nothing filled`,
      });
      return;
    }
    if (opened) await this.placeProtectiveStop(opened);
    if (working.purpose === 'exit') await this.announceHalts();
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
            {
              productId: position.productId,
              price: price.toFixed(),
              stop: position.stopPrice.toFixed(),
              reason,
            },
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
        // Recorded, so it alerts: the loop still counts as healthy (the dead-man
        // keeps pinging) while this position's stop goes unenforced.
        this.events.append({
          level: 'error',
          kind: 'error',
          message: `failed to check the stop for ${position.productId}: ${String(error)}`,
        });
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
    // A maker order in flight for it: the next bar waits until that has finished.
    // Fetched first all the same, so the market data never goes stale meanwhile.
    if (this.maker.find(productId)) return;
    if (fetched.length < this.strategy.warmupBars) return;
    const candles = fetched.slice(-this.strategy.lookbackBars);

    const newest = candles.at(-1)!;
    const granularity = newest.granularity;
    const stored =
      this.state.get(LAST_BAR_KEY(productId, granularity)) ??
      (granularity === 'ONE_HOUR' ? this.state.get(LEGACY_LAST_BAR_KEY(productId)) : null);
    const lastProcessed = Number(stored ?? 0);
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

    this.state.set(LAST_BAR_KEY(productId, granularity), String(newest.openTime));

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
      const reason = signal.exitReason ?? 'signal';
      // Only the strategy's own signal exit waits as a maker order. Stops never do.
      if (reason === 'signal' && this.maker.enabled) {
        if (await this.postMakerExit(position, D(newest.close))) return;
      }
      await this.closePosition(position, reason, D(newest.close));
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
      availableQuote: snapshot.availableCash,
      entryPrice: referencePrice,
      stopPrice: provisional.stopPrice,
      openNotional,
      product,
      limits: this.risk.limits,
      confidence: signal.confidence,
      ...(this.config.STRATEGY === 'regime'
        ? { allocationPct: this.config.REGIME_ALLOCATION_PCT }
        : {}),
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
      this.log.warn(
        { productId, rejections: decision.rejections },
        'risk engine refused the entry',
      );
      this.events.append({
        level: 'warn',
        kind: 'risk_rejected',
        message: `risk refused ${productId}: ${decision.rejections.join('; ')}`,
      });
      return;
    }
    for (const warning of decision.warnings) this.log.warn({ productId }, warning);

    const approved: OrderIntent = {
      ...intent,
      ...(decision.adjustedBaseSize ? { baseSize: decision.adjustedBaseSize } : {}),
    };
    if (this.maker.enabled) {
      const posted = await this.maker.post({
        purpose: 'entry',
        intent: approved,
        entry: {
          atr: D(atrValue),
          barOpenTime: bar.openTime,
          reasons: signal.reasons,
          confidence: signal.confidence,
        },
      });
      // Resting, or blocked for a human: either way, nothing more now.
      if (posted !== 'refused') return;
    }

    const result = await this.executor.execute(approved);
    const order = result.order;
    if (!order || order.status !== 'FILLED' || order.filledSize.lte(0)) return;

    const stored = this.openFromFills({
      productId,
      fill: { size: order.filledSize, price: order.averageFillPrice, fee: order.fee },
      atr: atrValue,
      openedAt: bar.openTime,
      reasons: signal.reasons,
      confidence: signal.confidence,
    });
    await this.placeProtectiveStop(stored);
  }

  /** Record a new position from what an entry filled. Synchronous, to share a transaction. */
  private openFromFills(args: {
    productId: string;
    fill: FillTotal;
    atr: Decimal | number;
    openedAt: number;
    reasons: string[];
    confidence: number;
  }): StoredPosition {
    const { productId, fill } = args;
    const entry = openPosition({
      productId,
      baseSize: fill.size,
      entryPrice: fill.price,
      atrValue: args.atr,
      openedAt: args.openedAt,
      config: this.stopConfig,
    });

    const stored: StoredPosition = {
      ...entry,
      barsHeld: 0,
      entryFee: fill.fee,
      protectiveStopOrderId: null,
      entryReasons: args.reasons,
      confidence: args.confidence,
      mode: this.config.TRADING_MODE,
    };
    this.positions.upsert(stored);

    this.log.info(
      {
        productId,
        size: fill.size.toFixed(),
        entry: fill.price.toFixed(),
        stop: entry.stopPrice.toFixed(),
        target: entry.takeProfitPrice?.toFixed() ?? null,
      },
      'position opened',
    );
    this.events.append({
      level: 'info',
      kind: 'position_opened',
      message: `opened ${productId} ${fill.size.toFixed()} @ ${fill.price.toFixed()}`,
      data: { stop: entry.stopPrice.toFixed(), reasons: args.reasons },
    });
    return stored;
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
      // But it must be seen: while the engine is down, nothing else protects the
      // position, and until now this failure reached only the log file.
      this.log.error(
        { productId: position.productId, err: String(error) },
        'could not place the exchange-side protective stop; engine stop is now the only floor',
      );
      this.events.append({
        level: 'error',
        kind: 'error',
        message:
          `could not place the exchange-side stop for ${position.productId}: ${String(error)}. ` +
          'The engine still enforces its own stop while it runs; while it is down, nothing protects this position.',
        data: { productId: position.productId },
      });
    }
  }

  /**
   * Post a signal exit as a maker order (MAKER_ORDERS). True when nothing more
   * should happen now: it rests, or it is blocked for a human. False when it
   * was refused, and the caller exits at market instead.
   */
  private async postMakerExit(position: StoredPosition, referencePrice: Decimal): Promise<boolean> {
    // The exchange-side stop holds the coins, so it has to go before a sell can rest.
    const current = await this.cancelProtectiveStop(position);
    const intent: OrderIntent = {
      productId: current.productId,
      side: 'SELL',
      baseSize: current.baseSize,
      referencePrice,
      reason: 'exit: signal',
      exitReason: 'signal',
      idempotencyKey: ExecutorService.idempotencyKey({
        mode: this.config.TRADING_MODE,
        productId: current.productId,
        side: 'SELL',
        bar: Math.floor(Date.now() / 60_000),
        purpose: 'signal',
      }),
    };
    const { decision } = await this.risk.assess(intent);
    if (!decision.approved) return false;
    const posted = await this.maker.post({
      purpose: 'exit',
      intent: { ...intent, baseSize: decision.adjustedBaseSize ?? intent.baseSize },
      exitReason: 'signal',
    });
    return posted !== 'refused';
  }

  /**
   * Cancel the exchange-side stop, and forget it once cancelled, so a later
   * exit does not try again. On failure it is kept, and the exit carries on.
   */
  private async cancelProtectiveStop(position: StoredPosition): Promise<StoredPosition> {
    if (!position.protectiveStopOrderId) return position;
    try {
      await this.exchange.cancelOrders([position.protectiveStopOrderId]);
    } catch (error) {
      this.log.warn(
        { productId: position.productId, err: String(error) },
        'could not cancel the protective stop before exiting',
      );
      return position;
    }
    const cleared: StoredPosition = { ...position, protectiveStopOrderId: null };
    this.positions.upsert(cleared);
    return cleared;
  }

  private async closePosition(
    open: StoredPosition,
    reason: ExitReason,
    referencePrice: Decimal,
  ): Promise<void> {
    let position = open;
    // A maker exit still resting for it is ended first, and its fills booked:
    // selling at market while it rests could sell the same coins twice.
    const working = this.maker.find(position.productId);
    if (working) {
      const outcome = await this.maker.abort(working);
      if (!outcome) {
        this.log.warn(
          { productId: position.productId, reason },
          'the maker order is not confirmed cancelled yet; exiting on the next pass',
        );
        return;
      }
      await this.complete(outcome);
      const left = this.positions.find(position.productId);
      if (!left) return;
      position = left;
    }

    // Cancel the exchange-side stop FIRST. Selling while it rests would leave a
    // stop order against coins we no longer hold.
    position = await this.cancelProtectiveStop(position);

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

    const sold = position;
    this.db.transaction(() =>
      this.bookExit(sold, reason, {
        size: order.filledSize,
        price: order.averageFillPrice,
        fee: order.fee,
      }),
    )();

    // A losing streak or the daily loss limit can only begin here. Without this,
    // those halts blocked every later entry silently: the only trace was a
    // risk_rejected event, which by design never alerts.
    await this.announceHalts();
  }

  /** Record an exit's trade and what is left of the position. Synchronous, to share a transaction. */
  private bookExit(position: StoredPosition, reason: ExitReason, fill: FillTotal): void {
    const proceeds = fill.size.mul(fill.price);
    const costBasis = fill.size.mul(position.averageEntryPrice);
    // Apportion the entry fee to the fraction actually sold, so a partial exit
    // does not charge the whole entry cost against it.
    const soldFraction = position.baseSize.gt(0) ? fill.size.div(position.baseSize) : D(1);
    const fees = position.entryFee.mul(soldFraction).plus(fill.fee);
    const pnl = proceeds.minus(costBasis).minus(fees);

    this.trades.insert({
      productId: position.productId,
      entryTime: position.openedAt * 1000,
      exitTime: Date.now(),
      entryPrice: position.averageEntryPrice,
      exitPrice: fill.price,
      baseSize: fill.size,
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

    const remaining = position.baseSize.minus(fill.size);
    if (remaining.gt(0)) {
      this.log.warn(
        { productId: position.productId, remaining: remaining.toFixed() },
        'exit filled only partially; keeping the remainder open',
      );
      this.positions.upsert({
        ...position,
        baseSize: remaining,
        entryFee: position.entryFee.mul(D(1).minus(soldFraction)),
      });
    } else {
      this.positions.remove(position.productId);
    }

    this.log.info(
      {
        productId: position.productId,
        reason,
        pnl: pnl.toFixed(2),
        exit: fill.price.toFixed(),
      },
      'position closed',
    );
    this.events.append({
      level: pnl.gte(0) ? 'info' : 'warn',
      kind: 'position_closed',
      message: `closed ${position.productId} (${reason}) P&L ${pnl.toFixed(2)}`,
      data: {
        pnl: pnl.toFixed(),
        fees: fees.toFixed(),
        exitPrice: fill.price.toFixed(),
      },
    });
  }

  private async announceHalts(): Promise<void> {
    try {
      await this.risk.announceHalts();
    } catch (error) {
      // Announcing is best effort; it must never fail an exit or a startup.
      this.log.warn({ err: String(error) }, 'could not check for new halts');
    }
  }

  /** Flatten everything at market. Used by the dashboard's panic button. */
  async flattenAll(reason: ExitReason = 'manual'): Promise<number> {
    // Maker orders first. An entry still resting is cancelled, and whatever it
    // bought becomes a position, flattened below with the rest.
    for (const working of this.maker.list()) {
      const outcome = await this.maker.abort(working);
      if (outcome) await this.complete(outcome);
    }

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
