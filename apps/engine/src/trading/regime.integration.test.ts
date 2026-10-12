import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRANULARITY_SECONDS, atr, type Candle } from '@crypto-magic/core';
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
import {
  FakeMarketData,
  candlesEndingNow,
  seriesCrossingUpOnLastBar,
} from '../testing/fake-exchange';
import { TradingEngineService } from './engine.service';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { MakerOrderService } from './maker-order.service';
import { PortfolioService } from './portfolio.service';
import { ReconciliationService } from './reconciliation.service';
import { RiskService } from './risk.service';

const DAY = GRANULARITY_SECONDS.ONE_DAY * 1000;
/** 260 flat days, then a close well above the 200-day average. */
const RISING = [...Array<number>(260).fill(100), 110];

/**
 * The regime filter as the engine runs it: daily bars, allocation sizing and
 * the same disaster-floor stop as Experiment 001's backtest.
 */
describe('regime strategy (integration)', () => {
  let dir: string;
  let market: FakeMarketData;
  const booted: TestingModule[] = [];

  const configFor = (env: Record<string, string>): AppConfig =>
    loadConfig({
      TRADING_MODE: 'paper',
      PRODUCTS: 'BTC-USD',
      DATABASE_PATH: join(dir, 'engine.db'),
      KILL_SWITCH_FILE: join(dir, 'KILL_SWITCH'),
      PAPER_STARTING_CASH: '10000',
      // Wide enough that only the allocation and the cash can bind.
      MAX_POSITION_NOTIONAL: '20000',
      MAX_TOTAL_NOTIONAL: '20000',
      MIN_ORDER_NOTIONAL: '1',
      PROTECTIVE_STOP_ENABLED: 'false',
      LOG_LEVEL: 'fatal',
      ...env,
    });
  const regime = () => configFor({ STRATEGY: 'regime', GRANULARITY: 'ONE_DAY' });
  const taEnsemble = () => configFor({ GRANULARITY: 'ONE_HOUR', REQUIRE_TREND_FILTER: 'false' });

  beforeEach(() => {
    // Only the clock: candlesEndingNow and the engine both read Date.now().
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
    dir = mkdtempSync(join(tmpdir(), 'cm-regime-'));
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

  /** One engine process on the shared database file, as in paper-restart. */
  async function boot(config: AppConfig): Promise<TestingModule> {
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

  /** Startup as the app runs it, waiting for the first pass it kicks off. */
  async function start(moduleRef: TestingModule): Promise<void> {
    const engine = moduleRef.get(TradingEngineService);
    await engine.onApplicationBootstrap();
    await vi.waitFor(() => expect(engine.lastSuccessfulTickAt).not.toBeNull());
  }

  it('enters above the 200-day average, sized to the allocation, with the 10-ATR stop', async () => {
    const app = await boot(regime());
    await app.get(TradingEngineService).tick();

    const [position] = app.get(PositionRepository).findAll();
    expect(position).toBeDefined();

    // 100% of 10,000 equity, less the 1% fee reserve.
    const notional = position!.baseSize.mul(position!.averageEntryPrice).toNumber();
    expect(notional).toBeGreaterThan(9_890);
    expect(notional).toBeLessThanOrEqual(9_900);
    expect((await app.get(PortfolioService).availableQuote()).toNumber()).toBeGreaterThan(0);

    // The regime filter's disaster floor, not ta-ensemble's 2-ATR stop.
    const window = market.candles.slice(-createStrategy(regime()).lookbackBars);
    const atrValue = atr(window, 14).at(-1)!;
    const distance = position!.averageEntryPrice.minus(position!.stopPrice).toNumber();
    expect(distance).toBeCloseTo(10 * atrValue, 6);
    expect(position!.takeProfitPrice).toBeNull();
  });

  it('holds through a drop a 2-ATR stop would take, then exits on a close below the average', async () => {
    const app = await boot(regime());
    const engine = app.get(TradingEngineService);
    await engine.tick();
    const [position] = app.get(PositionRepository).findAll();
    const atrValue = position!.averageEntryPrice.minus(position!.stopPrice).toNumber() / 10;

    // Next day: down more than 2 ATR, still above the average.
    vi.setSystemTime(Date.now() + DAY);
    const dropped = 105;
    expect(110 - dropped).toBeGreaterThan(2 * atrValue);
    showDaily([...RISING, dropped]);
    await engine.tick();
    expect(app.get(PositionRepository).findAll()).toHaveLength(1);

    // The day after: a close just under the average, but above the stop.
    vi.setSystemTime(Date.now() + DAY);
    showDaily([...RISING, dropped, 99]);
    await engine.tick();

    expect(app.get(PositionRepository).findAll()).toHaveLength(0);
    const [trade] = app.get(TradeRepository).all();
    expect(trade!.exitReason).toBe('signal');
  });

  it('exits on the 10-ATR disaster stop between daily closes', async () => {
    const app = await boot(regime());
    const engine = app.get(TradingEngineService);
    await engine.tick();

    market.price = 80; // intraday crash, far below entry - 10 ATR
    await engine.tick();

    expect(app.get(PositionRepository).findAll()).toHaveLength(0);
    expect(app.get(TradeRepository).all()[0]!.exitReason).toBe('stop_loss');
  });

  it('acts on daily bars after running hourly, which the single last-bar key used to skip', async () => {
    const app = await boot(regime());
    // What an hourly engine left behind: the open time of the last hourly bar.
    const lastHourly = Math.floor(Date.now() / 3_600_000) * 3_600 - 3_600;
    app.get(StateRepository).set('last_bar:BTC-USD', String(lastHourly));
    // The old comparison: the newest daily bar looks already processed.
    expect(market.candles.at(-1)!.openTime).toBeLessThan(lastHourly);

    await app.get(TradingEngineService).tick();

    expect(app.get(PositionRepository).findAll()).toHaveLength(1);
  });

  it('still honours the pre-upgrade key for hourly bars, so no bar is processed twice', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;
    const app = await boot(taEnsemble());
    const state = app.get(StateRepository);
    // Recorded before the upgrade: this exact bar was already acted on.
    state.set('last_bar:BTC-USD', String(market.candles.at(-1)!.openTime));

    await app.get(TradingEngineService).tick();

    expect(app.get(PositionRepository).findAll()).toHaveLength(0);
    expect(state.get('last_bar:BTC-USD:ONE_HOUR')).toBeNull();
  });

  describe('switching strategy', () => {
    const killSwitch = (app: TestingModule) => app.get(KillSwitchService).isEngaged();

    it('engages the kill switch when the strategy changes with a position open', async () => {
      const first = await boot(regime());
      await start(first);
      expect(first.get(PositionRepository).findAll()).toHaveLength(1);
      await shutdown(first);

      const second = await boot(taEnsemble());
      await start(second);

      expect(killSwitch(second)).toBe(true);
      const engaged = second
        .get(EventRepository)
        .recent(50)
        .find((e) => e.kind === 'kill_switch');
      expect(engaged?.message).toContain('strategy changed from regime-sma200 to ta-ensemble-v1');
      // Not recorded yet, so the next restart checks again.
      expect(second.get(StateRepository).get('strategy')).toBe('regime-sma200');
    });

    it('treats positions opened before the strategy was recorded as ta-ensemble ones', async () => {
      const series = seriesCrossingUpOnLastBar();
      market.candles = candlesEndingNow(series);
      market.price = series.at(-1)!;
      const first = await boot(taEnsemble());
      await first.get(TradingEngineService).tick(); // no startup, so nothing recorded
      expect(first.get(PositionRepository).findAll()).toHaveLength(1);
      expect(first.get(StateRepository).get('strategy')).toBeNull();
      await shutdown(first);

      showDaily(RISING);
      const second = await boot(regime());
      await start(second);

      expect(killSwitch(second)).toBe(true);
    });

    it('switches cleanly while flat, and says so', async () => {
      market.candles = []; // no bars, so the first engine never trades
      const first = await boot(taEnsemble());
      await start(first);
      expect(first.get(StateRepository).get('strategy')).toBe('ta-ensemble-v1');
      await shutdown(first);

      showDaily(RISING);
      const second = await boot(regime());
      await start(second);

      expect(killSwitch(second)).toBe(false);
      expect(second.get(StateRepository).get('strategy')).toBe('regime-sma200');
      const changed = second
        .get(EventRepository)
        .recent(50)
        .find((e) => e.kind === 'strategy_changed');
      expect(changed?.message).toBe('strategy changed from ta-ensemble-v1 to regime-sma200');
    });
  });
});
