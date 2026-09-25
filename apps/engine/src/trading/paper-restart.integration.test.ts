import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toRiskLimits, toStopConfig, toStrategyConfig } from '../config/config.module';
import { APP_CONFIG, RISK_LIMITS, STOP_CONFIG, STRATEGY_CONFIG } from '../config/tokens';
import { loadConfig, type AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { createPaperAdapter, PAPER_BALANCES_KEY } from '../exchange/exchange.module';
import { MarketDataService } from '../market-data/market-data.service';
import { DATABASE } from '../persistence/tokens';
import { openDatabase, type Db } from '../persistence/database';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { FakeMarketData, candlesEndingNow, seriesCrossingUpOnLastBar } from '../testing/fake-exchange';
import { TradingEngineService } from './engine.service';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { PortfolioService } from './portfolio.service';
import { ReconciliationService } from './reconciliation.service';
import { RiskService } from './risk.service';

/**
 * A paper account must survive a restart: launchd restarts, reboots and moving
 * to a new Mac all restart the engine. It used to live only in memory, so a
 * restart reset the cash and reconciliation deleted every open paper position.
 */
describe('paper account across a restart (integration)', () => {
  let dir: string;
  let config: AppConfig;
  let market: FakeMarketData;
  const booted: TestingModule[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-restart-'));
    config = loadConfig({
      TRADING_MODE: 'paper',
      PRODUCTS: 'BTC-USD',
      GRANULARITY: 'ONE_HOUR',
      DATABASE_PATH: join(dir, 'engine.db'),
      KILL_SWITCH_FILE: join(dir, 'KILL_SWITCH'),
      PAPER_STARTING_CASH: '10000',
      REQUIRE_TREND_FILTER: 'false',
      MAX_POSITION_NOTIONAL: '2000',
      MAX_TOTAL_NOTIONAL: '5000',
      MIN_ORDER_NOTIONAL: '1',
      PROTECTIVE_STOP_ENABLED: 'false',
      LOG_LEVEL: 'fatal',
    } as NodeJS.ProcessEnv);
    market = new FakeMarketData();
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;
  });

  afterEach(async () => {
    for (const moduleRef of booted.splice(0)) await shutdown(moduleRef);
    rmSync(dir, { recursive: true, force: true });
  });

  /** One engine process: same database file each time, fresh memory each time. */
  async function boot({ persistPaper }: { persistPaper: boolean }): Promise<TestingModule> {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RISK_LIMITS, useValue: toRiskLimits(config) },
        { provide: STOP_CONFIG, useValue: toStopConfig(config) },
        { provide: STRATEGY_CONFIG, useValue: toStrategyConfig(config) },
        { provide: DATABASE, useFactory: () => openDatabase(config.DATABASE_PATH) },
        {
          provide: EXCHANGE,
          useFactory: (state: StateRepository) =>
            createPaperAdapter(config, market, persistPaper ? state : undefined),
          inject: [StateRepository],
        },
        PositionRepository,
        OrderRepository,
        TradeRepository,
        EventRepository,
        StateRepository,
        MarketDataService,
        KillSwitchService,
        PortfolioService,
        RiskService,
        ExecutorService,
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

  const usd = async (moduleRef: TestingModule) =>
    (await moduleRef.get(PortfolioService).availableQuote()).toNumber();

  it('keeps the open position and the cash after a restart', async () => {
    const first = await boot({ persistPaper: true });
    await first.get(TradingEngineService).tick();
    const [position] = first.get(PositionRepository).findAll();
    expect(position).toBeDefined();
    const cashBefore = await usd(first);
    expect(cashBefore).toBeLessThan(10_000);
    expect(first.get(StateRepository).get(PAPER_BALANCES_KEY)).not.toBeNull();
    await shutdown(first);

    const second = await boot({ persistPaper: true });
    await second.get(ReconciliationService).reconcile();

    const after = second.get(PositionRepository).findAll();
    expect(after).toHaveLength(1);
    expect(after[0]!.baseSize.eq(position!.baseSize)).toBe(true);
    expect(await usd(second)).toBeCloseTo(cashBefore, 8);
  });

  it('(the old behaviour, for contrast) loses the position and resets the cash without it', async () => {
    const first = await boot({ persistPaper: false });
    await first.get(TradingEngineService).tick();
    expect(first.get(PositionRepository).findAll()).toHaveLength(1);
    await shutdown(first);

    const second = await boot({ persistPaper: false });
    await second.get(ReconciliationService).reconcile();

    expect(second.get(PositionRepository).findAll()).toHaveLength(0);
    expect(await usd(second)).toBe(10_000);
  });
});
