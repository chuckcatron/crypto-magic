import { Test, type TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { D } from '@crypto-magic/core';
import { PaperAdapter } from '@crypto-magic/exchange';
import { ApiController } from '../api/api.controller';
import { createStrategy, stopConfigFor, toRiskLimits } from '../config/config.module';
import { APP_CONFIG, RISK_LIMITS, STOP_CONFIG, STRATEGY } from '../config/tokens';
import { loadConfig, type AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { PAPER_STARTING_CASH_KEY } from '../exchange/exchange.module';
import { MarketDataService } from '../market-data/market-data.service';
import { DATABASE } from '../persistence/tokens';
import { openDatabase } from '../persistence/database';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository, type StoredTrade } from '../persistence/repositories/trade.repository';
import { NullNewsProvider } from '@crypto-magic/insight';
import { AlertPolicy, FanoutNotifier } from '@crypto-magic/notify';
import { AlertService } from '../alerts/alert.service';
import { DeadmanService } from '../alerts/deadman.service';
import { ALERT_POLICY, NOTIFIER } from '../alerts/tokens';
import { PostMortemService } from '../insight/postmortem.service';
import { LLM_CLIENT, NEWS_PROVIDER } from '../insight/tokens';
import { TradeAnalysisRepository } from '../persistence/repositories/trade-analysis.repository';
import {
  FakeMarketData,
  candlesEndingNow,
  seriesCrossingUpOnLastBar,
} from '../testing/fake-exchange';
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
    });

    market = new FakeMarketData();

    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      controllers: [ApiController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: RISK_LIMITS, useValue: toRiskLimits(config) },
        { provide: STOP_CONFIG, useValue: stopConfigFor(config) },
        { provide: STRATEGY, useValue: createStrategy(config) },
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

  it('serves when records began, and what the account started with, as the baseline', async () => {
    expect(api.equityBaseline()).toEqual({ baseline: null });

    // A live-mode record from before this paper account existed must not
    // become the paper baseline.
    const state = moduleRef.get(StateRepository);
    state.recordEquity({
      ts: 1,
      equity: D(50),
      cash: D(50),
      positionValue: D(0),
      mode: 'live',
    });

    // A quiet market, so nothing is bought and equity is exactly the starting cash.
    const series = seriesCrossingUpOnLastBar().slice(0, 118);
    market.candles = candlesEndingNow(series);
    market.price = series.at(-1)!;
    await engine.tick();
    const { baseline } = api.equityBaseline() as { baseline: { ts: number; equity: string } };
    expect(baseline.ts).toBeGreaterThan(1);
    // No starting cash recorded: falls back to the first snapshot.
    expect(baseline.equity).toBe('10000');

    // Later snapshots, at whatever equity, leave the baseline where it was.
    state.recordEquity({
      ts: baseline.ts + 30_000,
      equity: D(9000),
      cash: D(9000),
      positionValue: D(0),
      mode: 'paper',
    });
    expect(api.equityBaseline()).toEqual({ baseline });

    // The recorded starting cash wins over the first snapshot, which the first
    // tick may already have spent a fee from.
    state.set(PAPER_STARTING_CASH_KEY, '12000');
    expect(api.equityBaseline()).toEqual({ baseline: { ts: baseline.ts, equity: '12000' } });
  });

  it('serves traded prices, never watch-only ones, when nothing is watched', async () => {
    market.price = 123.45;
    const prices = (await api.prices()) as { productId: string; watchOnly: boolean }[];
    expect(prices.map((p) => [p.productId, p.watchOnly])).toEqual([['BTC-USD', false]]);
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
    expect(closed.takeProfitPrice?.toNumber()).toBeCloseTo(position.takeProfitPrice!.toNumber(), 8);
  });

  it('never exposes credentials through the config endpoint', () => {
    const safe = api.safeConfig() as Record<string, unknown>;
    expect(safe).not.toHaveProperty('COINBASE_API_KEY_NAME');
    expect(safe).not.toHaveProperty('COINBASE_API_PRIVATE_KEY');
    expect(safe).not.toHaveProperty('LIVE_TRADING_ACK');
    expect(safe.TRADING_MODE).toBe('paper');
  });

  describe('losing-streak halt', () => {
    const DAY_MS = 86_400_000;
    /** A small closed loss, yesterday by default so it stays out of today's loss limit. */
    const loss = (exitTime = Date.now() - DAY_MS): StoredTrade => ({
      productId: 'BTC-USD',
      entryTime: exitTime - 3_600_000,
      exitTime,
      entryPrice: D(100),
      exitPrice: D(99),
      baseSize: D(1),
      fees: D(0),
      pnl: D(-1),
      pnlPct: -1,
      exitReason: 'signal',
      entryReasons: [],
      confidence: 1,
      mode: 'paper',
      stopPrice: null,
      takeProfitPrice: null,
    });
    const haltAlerts = () =>
      events.recent().filter((e) => e.kind === 'halt' && e.level === 'error');
    const status = async () =>
      (await api.status()) as { haltReasons: string[]; lossStreak: number };

    it('alerts once, when the trade that completes the streak closes', async () => {
      for (let i = 0; i < 3; i++) trades.insert(loss());

      // A fourth loss, taken by the engine itself: open, then crash through the stop.
      const series = seriesCrossingUpOnLastBar();
      market.candles = candlesEndingNow(series);
      market.price = series.at(-1)!;
      await engine.tick();
      market.price = positions.findAll()[0]!.stopPrice.toNumber() * 0.97;
      await engine.tick();

      expect((await status()).haltReasons).toContain('consecutive_losses');
      const streakAlerts = haltAlerts().filter((e) => /losing trades in a row/.test(e.message));
      expect(streakAlerts).toHaveLength(1);
      expect(streakAlerts[0]!.message).toMatch(/4 losing trades in a row \(limit 4\)/);
      expect(streakAlerts[0]!.message).toMatch(/cm reset-streak/);

      // Checking again while still halted does not repeat the alert.
      await moduleRef.get(RiskService).announceHalts();
      expect(haltAlerts().filter((e) => /losing trades in a row/.test(e.message))).toHaveLength(1);
    });

    it('clears when the operator resets it, and counts only losses after that', async () => {
      for (let i = 0; i < 4; i++) trades.insert(loss());
      expect((await status()).haltReasons).toContain('consecutive_losses');

      expect(api.resetLossStreak()).toEqual({ cleared: 4 });
      expect(await status()).toMatchObject({ lossStreak: 0 });
      expect((await status()).haltReasons).not.toContain('consecutive_losses');
      // History is kept.
      expect(trades.all()).toHaveLength(4);
      expect(events.recent().some((e) => e.kind === 'halt' && e.level === 'info')).toBe(true);

      trades.insert(loss(Date.now() + 1000));
      expect((await status()).lossStreak).toBe(1);
    });

    it('lets entries resume after a reset', async () => {
      for (let i = 0; i < 4; i++) trades.insert(loss());
      api.resetLossStreak();

      const series = seriesCrossingUpOnLastBar();
      market.candles = candlesEndingNow(series);
      market.price = series.at(-1)!;
      await engine.tick();

      expect(positions.findAll()).toHaveLength(1);
    });

    it('announces a halt already in force when the engine starts', async () => {
      for (let i = 0; i < 4; i++) trades.insert(loss());

      await engine.onApplicationBootstrap();
      await vi.waitFor(() => expect(engine.lastSuccessfulTickAt).not.toBeNull());

      expect(haltAlerts().some((e) => /4 losing trades in a row/.test(e.message))).toBe(true);
    });
  });

  describe('silent failures', () => {
    it('alerts when the exchange-side stop cannot be placed', async () => {
      const config = moduleRef.get<AppConfig>(APP_CONFIG);
      (config as { PROTECTIVE_STOP_ENABLED: boolean }).PROTECTIVE_STOP_ENABLED = true;
      Object.assign(moduleRef.get(EXCHANGE), {
        submitProtectiveStop: async () => {
          throw new Error('Coinbase rejected the protective stop: INSUFFICIENT_FUND');
        },
      });

      const series = seriesCrossingUpOnLastBar();
      market.candles = candlesEndingNow(series);
      market.price = series.at(-1)!;
      await engine.tick();

      // The position still opens; only the backstop is missing, and now it says so.
      expect(positions.findAll()).toHaveLength(1);
      const event = events.recent().find((e) => /exchange-side stop/.test(e.message));
      expect(event).toMatchObject({ kind: 'error', level: 'error' });
      expect(event!.message).toMatch(/nothing protects this position/);
    });

    it('records a failure to check a stop, which the dead-man cannot see', async () => {
      const series = seriesCrossingUpOnLastBar();
      market.candles = candlesEndingNow(series);
      market.price = series.at(-1)!;
      await engine.tick();
      expect(positions.findAll()).toHaveLength(1);

      market.getTicker = async () => {
        throw new Error('ticker unavailable');
      };
      await engine.tick();

      const event = events.recent().find((e) => /failed to check the stop/.test(e.message));
      expect(event).toMatchObject({ kind: 'error', level: 'error' });
      // The pass itself still completed, which is why this needed its own event.
      expect(engine.lastSuccessfulTickAt).not.toBeNull();
    });

    it('says in the daily check-in when new entries are blocked', async () => {
      const alerts = moduleRef.get(AlertService);
      // No market data yet is itself a halt, and the check-in says so.
      expect(await alerts.heartbeatSummary()).toMatch(/^NEW ENTRIES BLOCKED: stale_market_data/);

      const series = seriesCrossingUpOnLastBar();
      market.candles = candlesEndingNow(series);
      market.price = series.at(-1)!;
      await engine.tick();
      expect(await alerts.heartbeatSummary()).toMatch(/^New entries allowed\./);

      moduleRef.get(KillSwitchService).engage('testing');
      const summary = await alerts.heartbeatSummary();
      expect(summary).toMatch(/^NEW ENTRIES BLOCKED: kill switch engaged\./);
      expect(summary).toMatch(/Equity:/);
    });
  });
});
