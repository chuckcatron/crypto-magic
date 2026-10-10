import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D, type Candle, type Decimal, type ProductSpec, type Ticker } from '@crypto-magic/core';
import {
  ExchangeError,
  type Balance,
  type BestBidAsk,
  type ExchangeAdapter,
  type MakerOrderRequest,
  type MarketOrderRequest,
  type OrderResult,
} from '@crypto-magic/exchange';
import { createStrategy, stopConfigFor, toRiskLimits } from '../config/config.module';
import { APP_CONFIG, RISK_LIMITS, STOP_CONFIG, STRATEGY } from '../config/tokens';
import { loadConfig, type AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { MarketDataService } from '../market-data/market-data.service';
import { DATABASE } from '../persistence/tokens';
import { openDatabase, type Db } from '../persistence/database';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { WorkingOrderRepository } from '../persistence/repositories/working-order.repository';
import { FAKE_PRODUCT, candlesEndingNow } from '../testing/fake-exchange';
import { TradingEngineService } from './engine.service';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { MAKER_WAIT_MS, MakerOrderService } from './maker-order.service';
import { PortfolioService } from './portfolio.service';
import { ReconciliationService } from './reconciliation.service';
import { RiskService } from './risk.service';

const START = Date.parse('2026-03-01T12:00:00Z');
const RISING = [...Array<number>(260).fill(100), 110];

/**
 * An exchange that keeps orders the way Coinbase does, so a test can say what
 * a resting order has filled, whether a cancel lands, and what goes wrong.
 * Paper cannot fill part of an order or fail one; this can.
 */
class ScriptedExchange implements ExchangeAdapter {
  readonly name = 'scripted';
  isLive = false;
  price = 110;
  candles: Candle[] = [];
  readonly orders = new Map<string, OrderResult>();
  /** What getOrder reports for the maker order next, when set. */
  makerState: Partial<OrderResult> | null = null;
  cancelLands = true;
  failMakerWith: Error | null = null;
  marketOrders: MarketOrderRequest[] = [];
  private usd = D(10_000);
  private sequence = 0;

  async getProduct(): Promise<ProductSpec> {
    return FAKE_PRODUCT;
  }
  async getCandles(): Promise<Candle[]> {
    return this.candles;
  }
  async getTicker(productId: string): Promise<Ticker> {
    return { productId, price: this.price, timestamp: Date.now() };
  }
  async getBestBidAsk(): Promise<BestBidAsk> {
    return { bid: D(this.price).minus(0.01), ask: D(this.price).plus(0.01) };
  }
  async getBalances(): Promise<Balance[]> {
    return [{ currency: 'USD', available: this.usd, hold: D(0) }];
  }
  async submitMakerOrder(request: MakerOrderRequest): Promise<OrderResult> {
    if (this.failMakerWith) throw this.failMakerWith;
    return this.store({
      orderId: `mk-${++this.sequence}`,
      clientOrderId: request.clientOrderId,
      productId: request.productId,
      side: request.side,
      status: 'OPEN',
      filledSize: D(0),
      averageFillPrice: D(0),
      fee: D(0),
      createdAt: Date.now(),
    });
  }
  async submitMarketOrder(request: MarketOrderRequest): Promise<OrderResult> {
    this.marketOrders.push(request);
    return this.store({
      orderId: `mkt-${++this.sequence}`,
      clientOrderId: request.clientOrderId,
      productId: request.productId,
      side: request.side,
      status: 'FILLED',
      filledSize: request.baseSize,
      averageFillPrice: D(this.price),
      fee: request.baseSize.mul(this.price).mul(0.006),
      createdAt: Date.now(),
    });
  }
  async getOrder(orderId: string): Promise<OrderResult | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (orderId.startsWith('mk-') && this.makerState) {
      return this.store({ ...order, ...this.makerState });
    }
    return order;
  }
  async listOpenOrders(): Promise<OrderResult[]> {
    return [];
  }
  async cancelOrders(orderIds: string[]): Promise<void> {
    if (!this.cancelLands) return;
    for (const id of orderIds) {
      const order = this.orders.get(id);
      if (order && (order.status === 'OPEN' || order.status === 'PENDING')) {
        this.makerState = { ...(this.makerState ?? {}), status: 'CANCELLED' };
      }
    }
  }
  forget(orderId: string): void {
    this.orders.delete(orderId);
  }
  private store(order: OrderResult): OrderResult {
    this.orders.set(order.orderId, order);
    return order;
  }
}

describe('maker orders, edge cases (integration)', () => {
  let dir: string;
  let exchange: ScriptedExchange;
  const booted: TestingModule[] = [];

  const config = (): AppConfig =>
    loadConfig({
      TRADING_MODE: 'paper',
      PRODUCTS: 'BTC-USD',
      STRATEGY: 'regime',
      GRANULARITY: 'ONE_DAY',
      MAKER_ORDERS: 'true',
      DATABASE_PATH: join(dir, 'engine.db'),
      KILL_SWITCH_FILE: join(dir, 'KILL_SWITCH'),
      MAX_POSITION_NOTIONAL: '20000',
      MAX_TOTAL_NOTIONAL: '20000',
      MIN_ORDER_NOTIONAL: '1',
      PROTECTIVE_STOP_ENABLED: 'false',
      LOG_LEVEL: 'fatal',
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    dir = mkdtempSync(join(tmpdir(), 'cm-maker-edge-'));
    exchange = new ScriptedExchange();
    exchange.candles = candlesEndingNow(RISING, 'ONE_DAY');
  });

  afterEach(async () => {
    for (const moduleRef of booted.splice(0)) {
      const db = moduleRef.get<Db>(DATABASE);
      await moduleRef.close();
      if (db.open) db.close();
    }
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  async function boot(): Promise<TestingModule> {
    const cfg = config();
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: RISK_LIMITS, useValue: toRiskLimits(cfg) },
        { provide: STOP_CONFIG, useValue: stopConfigFor(cfg) },
        { provide: STRATEGY, useValue: createStrategy(cfg) },
        { provide: DATABASE, useFactory: () => openDatabase(cfg.DATABASE_PATH) },
        { provide: EXCHANGE, useValue: exchange },
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

  const tick = (app: TestingModule) => app.get(TradingEngineService).tick();
  const working = (app: TestingModule) => app.get(MakerOrderService).list();
  const position = (app: TestingModule) => app.get(PositionRepository).find('BTC-USD');
  const pastDeadline = () => vi.setSystemTime(START + MAKER_WAIT_MS + 60_000);
  const filled = (size: string, price: number): Partial<OrderResult> => ({
    filledSize: D(size),
    averageFillPrice: D(price),
    fee: D(size).mul(price).mul(0.004),
  });

  it('books a part-filled maker order and the market order for the rest as one position', async () => {
    const app = await boot();
    await tick(app);
    const [order] = working(app);
    const half: Decimal = order!.baseSize.div(2);
    exchange.makerState = { status: 'OPEN', ...filled(half.toFixed(), 109.99) };

    await tick(app);
    expect(working(app)).toHaveLength(1); // still resting, part-filled

    pastDeadline();
    await tick(app);

    expect(working(app)).toHaveLength(0);
    const [cross] = exchange.marketOrders;
    expect(cross!.baseSize.toFixed()).toBe(
      order!.baseSize.minus(half).toDecimalPlaces(8, 1).toFixed(),
    );
    expect(cross!.clientOrderId).toMatch(/-entry-cross$/);
    const opened = position(app)!;
    expect(opened.baseSize.toFixed()).toBe(half.plus(cross!.baseSize).toFixed());
    // Size-weighted between the maker fill at 109.99 and the market fill at 110.
    expect(opened.averageEntryPrice.toNumber()).toBeGreaterThan(109.99);
    expect(opened.averageEntryPrice.toNumber()).toBeLessThan(110);
    expect(opened.entryFee.toNumber()).toBeCloseTo(
      half.mul(109.99).mul(0.004).plus(cross!.baseSize.mul(110).mul(0.006)).toNumber(),
      8,
    );
  });

  it('never sends the market order while a cancel is unconfirmed', async () => {
    const app = await boot();
    await tick(app);
    exchange.makerState = { status: 'OPEN' };
    exchange.cancelLands = false;

    pastDeadline();
    await tick(app);
    expect(exchange.marketOrders).toHaveLength(0);
    expect(working(app)).toHaveLength(1);

    exchange.cancelLands = true;
    await tick(app);
    expect(exchange.marketOrders).toHaveLength(1);
    expect(position(app)).not.toBeNull();
  });

  it('live, an order the exchange cannot find stops trading instead of guessing', async () => {
    exchange.isLive = true;
    const app = await boot();
    await tick(app);
    exchange.forget(working(app)[0]!.makerOrderId);

    await tick(app);

    expect(app.get(KillSwitchService).isEngaged()).toBe(true);
    expect(exchange.marketOrders).toHaveLength(0);
    expect(working(app)).toHaveLength(0);
    expect(position(app)).toBeNull();
  });

  it('an unclear submission stops trading, and is let go once it must have expired', async () => {
    exchange.failMakerWith = new ExchangeError('socket hang up', undefined, true);
    const app = await boot();
    await tick(app);

    expect(app.get(KillSwitchService).isEngaged()).toBe(true);
    expect(exchange.marketOrders).toHaveLength(0);
    expect(working(app)).toHaveLength(1);

    pastDeadline();
    await tick(app);
    expect(working(app)).toHaveLength(0);
    expect(exchange.marketOrders).toHaveLength(0);
    const note = app
      .get(EventRepository)
      .recent(20)
      .find((e) => e.message.includes('never confirmed'));
    expect(note?.level).toBe('warn');
  });

  it('reads back a market order sent before a crash, never sending a second', async () => {
    const app = await boot();
    await tick(app);
    exchange.makerState = { status: 'EXPIRED' };
    pastDeadline();
    // The market order went out and filled, then the process died before booking it.
    const [order] = working(app);
    await app.get(ExecutorService).execute({
      productId: 'BTC-USD',
      side: 'BUY',
      baseSize: order!.baseSize,
      referencePrice: D(110),
      reason: 'test',
      idempotencyKey: order!.crossClientOrderId,
    });
    expect(exchange.marketOrders).toHaveLength(1);

    await tick(app);

    expect(exchange.marketOrders).toHaveLength(1);
    expect(working(app)).toHaveLength(0);
    expect(position(app)!.baseSize.eq(exchange.marketOrders[0]!.baseSize)).toBe(true);
  });
});
