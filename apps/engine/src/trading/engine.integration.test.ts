import { Test, type TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaperAdapter } from '@crypto-magic/exchange';
import { ApiController } from '../api/api.controller';
import { toRiskLimits, toStopConfig, toStrategyConfig } from '../config/config.module';
import { APP_CONFIG, RISK_LIMITS, STOP_CONFIG, STRATEGY_CONFIG } from '../config/tokens';
import { loadConfig, type AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { MarketDataService } from '../market-data/market-data.service';
import { DATABASE } from '../persistence/tokens';
import { openDatabase } from '../persistence/database';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { NullNewsProvider } from '@crypto-magic/insight';
import { AlertPolicy, FanoutNotifier } from '@crypto-magic/notify';
import { AlertService } from '../alerts/alert.service';
import { DeadmanService } from '../alerts/deadman.service';
import { ALERT_POLICY, NOTIFIER } from '../alerts/tokens';
import { PostMortemService } from '../insight/postmortem.service';
import { LLM_CLIENT, NEWS_PROVIDER } from '../insight/tokens';
import { TradeAnalysisRepository } from '../persistence/repositories/trade-analysis.repository';
import { FakeMarketData, candlesEndingNow, seriesCrossingUpOnLastBar } from '../testing/fake-exchange';
import { TradingEngineService } from './engine.service';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { PortfolioService } from './portfolio.service';
import { ReconciliationService } from './reconciliation.service';
import { RiskService } from './risk.service';

describe('TradingEngineService (integration)', () => {
  let moduleRef: TestingModule;
  let engine: TradingEngineService;
  let market: FakeMarketData;
  let positions: PositionRepository;
  let trades: TradeRepository;
  let events: EventRepository;
  let api: ApiController;
  let killSwitchFile: string;

  beforeEach(async () => {
    killSwitchFile = `/tmp/crypto-magic-test-kill-${process.pid}-${Math.random().toString(36).slice(2)}`;

    const config: AppConfig = loadConfig({
      TRADING_MODE: 'paper',
      PRODUCTS: 'BTC-USD',
      GRANULARITY: 'ONE_HOUR',
      DATABASE_PATH: ':memory:',
      KILL_SWITCH_FILE: killSwitchFile,
      PAPER_STARTING_CASH: '10000',
      // Drop the 200-bar trend EMA so a test fixture need not be 400 bars long.
      REQUIRE_TREND_FILTER: 'false',
      MAX_POSITION_NOTIONAL: '2000',
      MAX_TOTAL_NOTIONAL: '5000',
      MIN_ORDER_NOTIONAL: '1',
      PROTECTIVE_STOP_ENABLED: 'false',
      LOG_LEVEL: 'fatal',
    } as NodeJS.ProcessEnv);

    market = new FakeMarketData();

    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      controllers: [ApiController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RISK_LIMITS, useValue: toRiskLimits(config) },
        { provide: STOP_CONFIG, useValue: toStopConfig(config) },
        { provide: STRATEGY_CONFIG, useValue: toStrategyConfig(config) },
        { provide: DATABASE, useFactory: () => openDatabase(':memory:') },
        {
          provide: EXCHANGE,
          useFactory: () =>
            new PaperAdapter({
              marketData: market,
              initialBalances: { USD: 10_000 },
              takerBps: 60,
              slippageBps: 5,
            }),
        },
        PositionRepository,
        OrderRepository,
        TradeRepository,
        TradeAnalysisRepository,
        EventRepository,
        StateRepository,
        // No local model configured. The engine must trade exactly the same.
        { provide: LLM_CLIENT, useValue: null },
        { provide: NEWS_PROVIDER, useValue: new NullNewsProvider() },
        PostMortemService,
        // No alert channels. Trading must behave identically.
        { provide: NOTIFIER, useValue: new FanoutNotifier([]) },
        { provide: ALERT_POLICY, useValue: new AlertPolicy() },
        AlertService,
        DeadmanService,
        MarketDataService,
        KillSwitchService,
        PortfolioService,
        RiskService,
        ExecutorService,
        ReconciliationService,
        TradingEngineService,
      ],
    }).compile();

    engine = moduleRef.get(TradingEngineService);
    positions = moduleRef.get(PositionRepository);
    trades = moduleRef.get(TradeRepository);
    events = moduleRef.get(EventRepository);
    api = moduleRef.get(ApiController);
  });

  afterEach(async () => {
    await moduleRef.close();
    const { rmSync } = await import('node:fs');
    rmSync(killSwitchFile, { force: true });
  });

  it('takes no position while the market is quiet', async () => {
    // Truncate before the cross: a quiet market with no fresh signal.
    const series = seriesCrossingUpOnLastBar().slice(0, 118);
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;

    await engine.tick();

    expect(positions.findAll()).toHaveLength(0);
  });

  it('opens a position on a valid signal, with a stop below entry', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;

    await engine.tick();

    const open = positions.findAll();
    expect(open).toHaveLength(1);
    const position = open[0]!;
    expect(position.productId).toBe('BTC-USD');
    expect(position.baseSize.toNumber()).toBeGreaterThan(0);
    expect(position.stopPrice.toNumber()).toBeLessThan(position.averageEntryPrice.toNumber());
    expect(position.entryReasons.length).toBeGreaterThan(0);
  });

  it('respects the per-position notional cap', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;

    await engine.tick();

    const position = positions.findAll()[0]!;
    const notional = position.baseSize.mul(position.averageEntryPrice).toNumber();
    expect(notional).toBeLessThanOrEqual(2000.000001);
  });

  it('exits at market when price falls through the stop, and records the trade', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;

    await engine.tick();
    const position = positions.findAll()[0]!;
    expect(position).toBeDefined();

    // Crash the price below the stop; the fast stop monitor should act on the
    // very next tick rather than waiting for a new bar.
    market.price = position.stopPrice.toNumber() * 0.97;
    await engine.tick();

    expect(positions.findAll()).toHaveLength(0);

    const recorded = trades.recent();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.exitReason).toBe('stop_loss');
    expect(recorded[0]!.pnl.toNumber()).toBeLessThan(0);
    expect(recorded[0]!.fees.toNumber()).toBeGreaterThan(0);
  });

  it('does not act twice on the same closed bar', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;

    await engine.tick();
    await engine.tick();
    await engine.tick();

    expect(positions.findAll()).toHaveLength(1);
    const orders = moduleRef.get(OrderRepository).recent();
    expect(orders.filter((o) => o.side === 'BUY')).toHaveLength(1);
  });

  it('blocks new entries while the kill switch is engaged', async () => {
    const killSwitch = moduleRef.get(KillSwitchService);
    killSwitch.engage('test');

    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;

    await engine.tick();

    expect(positions.findAll()).toHaveLength(0);
    expect(events.recent().some((e) => e.kind === 'risk_rejected')).toBe(true);
  });

  it('still exits an open position while the kill switch is engaged', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;
    await engine.tick();
    expect(positions.findAll()).toHaveLength(1);

    moduleRef.get(KillSwitchService).engage('halt everything');
    const position = positions.findAll()[0]!;
    market.price = position.stopPrice.toNumber() * 0.97;
    await engine.tick();

    // A halt must never trap us in a losing position.
    expect(positions.findAll()).toHaveLength(0);
    expect(trades.recent()).toHaveLength(1);
  });

  it('flattens everything on demand', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;
    await engine.tick();
    expect(positions.findAll()).toHaveLength(1);

    const closed = await engine.flattenAll('manual');

    expect(closed).toBe(1);
    expect(positions.findAll()).toHaveLength(0);
    expect(trades.recent()[0]!.exitReason).toBe('manual');
  });

  it('serves a coherent status and metrics payload to the dashboard', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;
    await engine.tick();

    const status = (await api.status()) as Record<string, unknown>;
    expect(status.mode).toBe('paper');
    expect(status.live).toBe(false);
    expect(status.killSwitchEngaged).toBe(false);

    const portfolio = (await api.portfolioSnapshot()) as Record<string, unknown>;
    // Decimals must serialize as strings, never as floats.
    expect(typeof portfolio.equity).toBe('string');

    const metrics = api.metrics() as Record<string, unknown>;
    expect(metrics.totalTrades).toBe(0);
  });

  it('trades normally with no alert channels configured', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;

    await engine.tick();

    expect(positions.findAll()).toHaveLength(1);
    expect(moduleRef.get(AlertService).status.enabled).toBe(false);
  });

  it('trades normally with no local model configured, and reports it as disabled', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;

    await engine.tick();

    // The whole insight layer being absent must be invisible to trading.
    expect(positions.findAll()).toHaveLength(1);
    expect(moduleRef.get(PostMortemService).status.enabled).toBe(false);
  });

  it('records the stop and target on a closed trade, for later analysis', async () => {
    const series = seriesCrossingUpOnLastBar();
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;
    await engine.tick();

    const position = positions.findAll()[0]!;
    market.price = position.stopPrice.toNumber() * 0.97;
    await engine.tick();

    const closed = trades.recent()[0]!;
    expect(closed.stopPrice?.toNumber()).toBeCloseTo(position.stopPrice.toNumber(), 8);
    expect(closed.takeProfitPrice?.toNumber()).toBeCloseTo(
      position.takeProfitPrice!.toNumber(),
      8,
    );
  });

  it('never exposes credentials through the config endpoint', () => {
    const safe = api.safeConfig() as Record<string, unknown>;
    expect(safe).not.toHaveProperty('COINBASE_API_KEY_NAME');
    expect(safe).not.toHaveProperty('COINBASE_API_PRIVATE_KEY');
    expect(safe).not.toHaveProperty('LIVE_TRADING_ACK');
    expect(safe.TRADING_MODE).toBe('paper');
  });
});
