import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D, GRANULARITY_SECONDS, type Candle } from '@crypto-magic/core';
import { createStrategy, stopConfigFor, toRiskLimits } from '../config/config.module';
import { APP_CONFIG, RISK_LIMITS, STOP_CONFIG, STRATEGY } from '../config/tokens';
import { loadConfig, type AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { createPaperAdapter } from '../exchange/exchange.module';
import { MarketDataService } from '../market-data/market-data.service';
import { DATABASE } from '../persistence/tokens';
import { openDatabase, type Db } from '../persistence/database';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { WorkingOrderRepository } from '../persistence/repositories/working-order.repository';
import { FakeMarketData, candlesEndingNow, minuteBar } from '../testing/fake-exchange';
import { TradingEngineService } from './engine.service';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { MAKER_WAIT_MS, MakerOrderService } from './maker-order.service';
import { PortfolioService } from './portfolio.service';
import { ReconciliationService } from './reconciliation.service';
import { RiskService } from './risk.service';

const DAY = GRANULARITY_SECONDS.ONE_DAY * 1000;
const MINUTE = 60_000;
/** 260 flat days, then a close well above the 200-day average. */
const RISING = [...Array<number>(260).fill(100), 110];
const START = Date.parse('2026-03-01T12:00:00Z');

/**
 * MAKER_ORDERS as the engine runs it (EXPERIMENT-011): the regime strategy's
 * own entries and signal exits rest as post-only limits for up to an hour,
 * then go at market. Paper fills a resting order only once a closed minute bar
 * trades through its limit.
 */
describe('maker orders (integration)', () => {
  let dir: string;
  let market: FakeMarketData;
  const booted: TestingModule[] = [];

  const configFor = (env: Record<string, string> = {}): AppConfig =>
    loadConfig({
      TRADING_MODE: 'paper',
      PRODUCTS: 'BTC-USD',
      STRATEGY: 'regime',
      GRANULARITY: 'ONE_DAY',
      MAKER_ORDERS: 'true',
      DATABASE_PATH: join(dir, 'engine.db'),
      KILL_SWITCH_FILE: join(dir, 'KILL_SWITCH'),
      PAPER_STARTING_CASH: '10000',
      MAX_POSITION_NOTIONAL: '20000',
      MAX_TOTAL_NOTIONAL: '20000',
      MIN_ORDER_NOTIONAL: '1',
      PROTECTIVE_STOP_ENABLED: 'false',
      LOG_LEVEL: 'fatal',
      ...env,
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    dir = mkdtempSync(join(tmpdir(), 'cm-maker-'));
    market = new FakeMarketData();
    showDaily(RISING);
  });

  afterEach(async () => {
    for (const moduleRef of booted.splice(0)) await shutdown(moduleRef);
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function showDaily(closes: number[]): Candle[] {
    market.candles = candlesEndingNow(closes, 'ONE_DAY');
    market.price = closes.at(-1)!;
    return market.candles;
  }

  async function boot(config: AppConfig = configFor()): Promise<TestingModule> {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RISK_LIMITS, useValue: toRiskLimits(config) },
        { provide: STOP_CONFIG, useValue: stopConfigFor(config) },
        { provide: STRATEGY, useValue: createStrategy(config) },
        { provide: DATABASE, useFactory: () => openDatabase(config.DATABASE_PATH) },
        {
          provide: EXCHANGE,
          useFactory: (state: StateRepository) => createPaperAdapter(config, market, state),
          inject: [StateRepository],
        },
        PositionRepository,
        OrderRepository,
        TradeRepository,
        EventRepository,
        StateRepository,
        WorkingOrderRepository,
        MarketDataService,
        KillSwitchService,
        PortfolioService,
        RiskService,
        ExecutorService,
        MakerOrderService,
        ReconciliationService,
        TradingEngineService,
      ],
    }).compile();
    booted.push(moduleRef);
    return moduleRef;
  }

  async function shutdown(moduleRef: TestingModule): Promise<void> {
    const index = booted.indexOf(moduleRef);
    if (index >= 0) booted.splice(index, 1);
    const db = moduleRef.get<Db>(DATABASE);
    await moduleRef.close();
    if (db.open) db.close();
  }

  const working = (app: TestingModule) => app.get(MakerOrderService).list();
  const positions = (app: TestingModule) => app.get(PositionRepository).findAll();
  const trades = (app: TestingModule) => app.get(TradeRepository).all();
  const ordersFor = (app: TestingModule) =>
    app
      .get(OrderRepository)
      .recent(50)
      .sort((a, b) => a.createdAt - b.createdAt);

  /** One tick that posts the entry: a buy resting at the bid. */
  async function postEntry(app: TestingModule) {
    await app.get(TradingEngineService).tick();
    const [order] = working(app);
    expect(order).toBeDefined();
    return order!;
  }

  /** Let a minute bar trade `through` a price, then tick a few minutes on. */
  async function tradeThrough(app: TestingModule, low: number, high: number) {
    market.minuteBars = [minuteBar(Date.now() + MINUTE, low, high)];
    vi.setSystemTime(Date.now() + 3 * MINUTE);
    await app.get(TradingEngineService).tick();
  }

  it('posts the entry as a buy at the bid, and opens nothing until it fills', async () => {
    const app = await boot();
    const order = await postEntry(app);

    expect(order.purpose).toBe('entry');
    expect(order.side).toBe('BUY');
    expect(order.limitPrice.toNumber()).toBe(109.99);
    expect(order.expiresAt).toBe(START + MAKER_WAIT_MS);
    expect(positions(app)).toHaveLength(0);
    const [maker] = ordersFor(app);
    expect(maker!.clientOrderId).toMatch(/-entry-maker$/);
    expect(maker!.status).toBe('OPEN');

    // The cash it holds is still ours: equity must not dip while it rests.
    const snapshot = await app.get(PortfolioService).snapshot();
    expect(snapshot.availableCash.toNumber()).toBeLessThan(100);
    expect(snapshot.equity.toNumber()).toBeCloseTo(10_000, 6);
  });

  it('does not act on the bar again while the order rests', async () => {
    const app = await boot();
    await postEntry(app);
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await app.get(TradingEngineService).tick();

    expect(working(app)).toHaveLength(1);
    expect(ordersFor(app)).toHaveLength(1);
  });

  it('opens the position at the limit, paying the maker fee, once the price trades through it', async () => {
    const app = await boot();
    const order = await postEntry(app);

    await tradeThrough(app, 109.9, 110.1);

    expect(working(app)).toHaveLength(0);
    const [position] = positions(app);
    expect(position!.averageEntryPrice.toNumber()).toBe(109.99);
    expect(position!.entryFee.toNumber()).toBeCloseTo(
      position!.baseSize.mul(109.99).mul(0.004).toNumber(),
      8,
    );
    expect(position!.baseSize.eq(order.baseSize.toDecimalPlaces(8, 1))).toBe(true);
    // Only the maker order: nothing went at market.
    expect(ordersFor(app).map((o) => o.status)).toEqual(['FILLED']);
  });

  it('does not fill on a bar that only touches the limit', async () => {
    const app = await boot();
    await postEntry(app);
    await tradeThrough(app, 109.99, 110.1);
    expect(working(app)).toHaveLength(1);
    expect(positions(app)).toHaveLength(0);
  });

  it('goes at market, at the taker fee, when the hour is up and nothing filled', async () => {
    const app = await boot();
    await postEntry(app);

    vi.setSystemTime(START + MAKER_WAIT_MS + MINUTE);
    await app.get(TradingEngineService).tick();

    expect(working(app)).toHaveLength(0);
    const [position] = positions(app);
    // The market fill: 110 plus 5 bps of slippage, and 60 bps of fee.
    expect(position!.averageEntryPrice.toNumber()).toBeCloseTo(110 * 1.0005, 8);
    expect(position!.entryFee.toNumber()).toBeCloseTo(
      position!.baseSize.mul(position!.averageEntryPrice).mul(0.006).toNumber(),
      8,
    );
    const [maker, cross] = ordersFor(app);
    expect(maker!.status).toBe('EXPIRED');
    expect(cross!.clientOrderId).toMatch(/-entry-cross$/);
    expect(cross!.status).toBe('FILLED');
  });

  it('exits on the signal with a sell at the ask, after cancelling the exchange-side stop', async () => {
    const app = await boot(configFor({ PROTECTIVE_STOP_ENABLED: 'true' }));
    await postEntry(app);
    await tradeThrough(app, 109.9, 110.1);
    const [opened] = positions(app);
    expect(opened!.protectiveStopOrderId).not.toBeNull();

    // The next day closes below the 200-day average.
    vi.setSystemTime(START + DAY);
    showDaily([...RISING, 99]);
    await app.get(TradingEngineService).tick();

    const [exit] = working(app);
    expect(exit!.purpose).toBe('exit');
    expect(exit!.side).toBe('SELL');
    expect(exit!.limitPrice.toNumber()).toBe(99.01);
    expect(positions(app)[0]!.protectiveStopOrderId).toBeNull();

    await tradeThrough(app, 98.9, 99.1);

    expect(working(app)).toHaveLength(0);
    expect(positions(app)).toHaveLength(0);
    const [trade] = trades(app);
    expect(trade!.exitReason).toBe('signal');
    expect(trade!.exitPrice.toNumber()).toBe(99.01);
  });

  it('a stop while an exit rests cancels it and sells at market', async () => {
    const app = await boot();
    await postEntry(app);
    await tradeThrough(app, 109.9, 110.1);
    vi.setSystemTime(START + DAY);
    showDaily([...RISING, 99]);
    await app.get(TradingEngineService).tick();
    expect(working(app)).toHaveLength(1);

    market.price = 80; // a crash through the 10-ATR stop
    await app.get(TradingEngineService).tick();

    expect(working(app)).toHaveLength(0);
    expect(positions(app)).toHaveLength(0);
    const [trade] = trades(app);
    expect(trade!.exitReason).toBe('stop_loss');
    expect(trade!.exitPrice.toNumber()).toBeCloseTo(80 * 0.9995, 8);
    expect(ordersFor(app).some((o) => o.clientOrderId.endsWith('-signal-maker'))).toBe(true);
  });

  it('the kill switch cancels a resting entry, and nothing goes at market', async () => {
    const app = await boot();
    await postEntry(app);
    app.get(KillSwitchService).engage('test');

    await app.get(TradingEngineService).tick();

    expect(working(app)).toHaveLength(0);
    expect(positions(app)).toHaveLength(0);
    expect(ordersFor(app).map((o) => o.status)).toEqual(['CANCELLED']);
    const snapshot = await app.get(PortfolioService).snapshot();
    expect(snapshot.availableCash.toNumber()).toBe(10_000);
  });

  it('the panic button cancels a resting entry', async () => {
    const app = await boot();
    await postEntry(app);

    await app.get(TradingEngineService).flattenAll();

    expect(working(app)).toHaveLength(0);
    expect(positions(app)).toHaveLength(0);
    expect((await app.get(PortfolioService).snapshot()).availableCash.toNumber()).toBe(10_000);
  });

  it('picks a resting entry up after a restart, without calling its coins unmanaged', async () => {
    const first = await boot();
    await postEntry(first);
    await shutdown(first);

    const second = await boot();
    const report = await second.get(ReconciliationService).reconcile();
    expect(report.working).toEqual(['BTC-USD']);
    expect(report.unmanagedBalances).toEqual([]);

    // Paper forgets resting orders on a restart, so it ends unfilled and the rest goes at market.
    await second.get(TradingEngineService).tick();

    expect(working(second)).toHaveLength(0);
    const [position] = positions(second);
    expect(position!.averageEntryPrice.toNumber()).toBeCloseTo(110 * 1.0005, 8);
    const legs = ordersFor(second).map((o) => [o.clientOrderId.split('-').at(-1), o.status]);
    expect(legs).toHaveLength(2);
    expect(legs).toContainEqual(['maker', 'CANCELLED']);
    expect(legs).toContainEqual(['cross', 'FILLED']);
  });

  it('goes straight to market when the exchange refuses the post-only order', async () => {
    // A crossed book: a buy at the bid would match at once, so post-only refuses it.
    market.book = { bid: D('110.02'), ask: D('110.01') };
    const app = await boot();
    await app.get(TradingEngineService).tick();

    expect(working(app)).toHaveLength(0);
    expect(positions(app)).toHaveLength(1);
    // Same timestamp, so compare without an order.
    const legs = ordersFor(app).map((o) => [o.clientOrderId.split('-').at(-1), o.status]);
    expect(legs).toHaveLength(2);
    expect(legs).toContainEqual(['maker', 'FAILED']);
    expect(legs).toContainEqual(['entry', 'FILLED']);
  });

  it('is refused on anything but daily bars', () => {
    expect(() => configFor({ GRANULARITY: 'ONE_HOUR', STRATEGY: 'ta-ensemble' })).toThrow(
      /MAKER_ORDERS=true needs GRANULARITY=ONE_DAY/,
    );
  });
});
