import { existsSync } from 'node:fs';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  BASE_COSTS,
  DAY,
  FIVE_MINUTES,
  FOUR_HOURS,
  INTRADAY_PRODUCTS,
  INTRADAY_STRATEGIES,
  IntradayAccount,
  MarketSeries,
  ROTATION_UNIVERSE,
  RotationAccount,
  sign,
  utcDay,
  type AccountListener,
  type Bar,
  type ClosedTrade,
  type IntradayAccountState,
  type IntradayStrategyId,
  type RotationAccountState,
} from '@crypto-magic/futures';
import type { Severity } from '@crypto-magic/notify';
import { childLogger } from '../common/logger';
import { FUTURES_CONFIG, type FuturesConfig } from '../config/config';
import { CANDLE_SOURCE, type CandleSource } from '../market/candle-source';
import { ALERTER, type Alerter } from './alerts';
import { pnlHistory, type EquitySource } from './pnl-history';
import { PaperStore, type TradeStats } from './store';

/** UNIX seconds now. Injected so tests can move time. */
export type Clock = () => number;
export const CLOCK = Symbol('CLOCK');

/**
 * A 5-minute decision older than this is one the bot only caught up on after
 * being down. Live, it could not have acted on it, so neither does paper.
 */
const STALE_INTRADAY_SECONDS = 10 * 60;
/** The rotation is processed after its day closes, so allow a day and a half. */
const STALE_DAILY_SECONDS = 36 * 3600;
/** Give Coinbase a moment to finish a bar before reading it. */
const SETTLE_SECONDS = 15;
const DAILY_SETTLE_SECONDS = 120;
/** Enough of each size for the longest window any strategy reads. */
const SERIES_LIMITS = { m5: 16_000, m15: 1_000, h4: 320 };
const ROTATION_ID = 'F4:universe';
/** F4's ranking needs 22 closes; fetch comfortably more on a cold start. */
const ROTATION_HISTORY_DAYS = 40;
const NO_TRADES: TradeStats = { trades: 0, wins: 0, netPnl: 0 };

function iso(t: number): string;
function iso(t: number | null): string | null;
function iso(t: number | null): string | null {
  return t === null ? null : new Date(t * 1000).toISOString();
}

interface IntradaySlot {
  readonly id: string;
  readonly strategyId: IntradayStrategyId;
  readonly productId: string;
  readonly account: IntradayAccount;
}

/**
 * The futures paper engine's loop.
 *
 * It runs EXPERIMENT-008's strategies forward on live Coinbase public prices,
 * through the same @crypto-magic/futures code the backtest used, with paper
 * money only. Nothing here can place an order: there is no exchange adapter
 * and no key. Fills are simulated exactly as in the backtest: decisions at bar
 * closes fill at the next bar's open, and stops and targets act like
 * exchange-side orders, judged on each bar's range as it closes.
 *
 * Every tick reads the 5-minute bars that have closed since the last one, feeds
 * them to the sub-accounts, and commits their state and any trades in one
 * transaction. A restart resumes from the last commit and replays what it
 * missed. Decisions on bars older than a few minutes (catch-up after downtime)
 * are refused, and so is every new entry while the kill-switch file exists.
 */
@Injectable()
export class PaperTraderService implements OnModuleDestroy {
  private readonly log = childLogger('paper');
  private readonly series = new Map<string, MarketSeries>();
  private readonly slots = new Map<string, IntradaySlot>();
  private rotation: RotationAccount | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private startedAt = 0;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private unsavedTrades: [string, ClosedTrade][] = [];
  private unsavedEvents: [Severity, string, string][] = [];

  constructor(
    @Inject(FUTURES_CONFIG) private readonly config: FuturesConfig,
    @Inject(CANDLE_SOURCE) private readonly candles: CandleSource,
    @Inject(ALERTER) private readonly alerter: Alerter,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly store: PaperStore,
  ) {}

  /**
   * Start trading: warm up, catch up, then poll. main.ts calls this only once
   * the API holds its port, so a second copy of the engine never gets here.
   */
  async run(): Promise<void> {
    await this.start();
    this.timer = setInterval(() => void this.tick(), this.config.FUTURES_POLL_SECONDS * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.close();
  }

  /** Build or restore the sub-accounts, then warm up and catch up in a first tick. */
  async start(): Promise<void> {
    const recorded = this.store.getMeta('started_at');
    this.startedAt = recorded
      ? Number(recorded)
      : Math.ceil(this.clock() / FIVE_MINUTES) * FIVE_MINUTES;
    if (!recorded) this.store.setMeta('started_at', String(this.startedAt));

    const equity = this.config.FUTURES_PAPER_EQUITY;
    for (const strategyId of this.config.FUTURES_STRATEGIES) {
      if (strategyId === 'F4') continue;
      for (const productId of INTRADAY_PRODUCTS) {
        const id = `${strategyId}:${productId}`;
        const account = new IntradayAccount(
          {
            productId,
            strategy: INTRADAY_STRATEGIES[strategyId],
            costs: BASE_COSTS,
            initialEquity: equity,
            tradeFrom: this.startedAt,
            entriesAllowed: (time) => this.entriesAllowed(time, STALE_INTRADAY_SECONDS),
          },
          this.store.loadState<IntradayAccountState>(id) ?? undefined,
        );
        account.listener = this.listenerFor(id);
        this.slots.set(id, { id, strategyId, productId, account });
      }
    }
    if (this.config.FUTURES_STRATEGIES.includes('F4')) {
      this.rotation = new RotationAccount(
        {
          costs: BASE_COSTS,
          initialEquity: equity,
          // The first whole UTC day after the engine first started.
          tradeFrom: utcDay(this.startedAt) + DAY,
          entriesAllowed: (time) => this.entriesAllowed(time, STALE_DAILY_SECONDS),
        },
        this.store.loadState<RotationAccountState>(ROTATION_ID) ?? undefined,
      );
    }

    const what = `${this.slots.size} intraday sub-account(s)${this.rotation ? ' and the F4 rotation' : ''}`;
    this.event('info', 'engine_started', `paper engine started with ${what}`);
    this.flush();
    this.log.info(
      { startedAt: this.startedAt, strategies: this.config.FUTURES_STRATEGIES },
      'started',
    );
    this.alerter.alert('info', 'engine_started', 'engine started', `Paper trading ${what}.`);
    await this.tick();
  }

  /** One pass: read newly closed bars and feed them through. Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const productId of this.intradayProducts()) await this.advanceIntraday(productId);
      if (this.rotation) await this.advanceRotation(this.rotation);
      this.lastTickAt = this.clock();
      this.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.log.warn({ err: message }, 'tick failed; will retry on the next one');
      this.event('warning', 'tick_failed', message);
      this.flush();
      this.alerter.alert('warning', 'tick_failed', 'a tick failed', message);
    } finally {
      this.ticking = false;
    }
  }

  status() {
    const stats = this.store.tradeStats();
    const equity = this.config.FUTURES_PAPER_EQUITY;
    const rotation = this.rotation;
    return {
      mode: 'paper' as const,
      startedAt: iso(this.startedAt),
      lastTickAt: iso(this.lastTickAt),
      lastError: this.lastError,
      killSwitch: existsSync(this.config.FUTURES_KILL_SWITCH_PATH),
      paperEquity: equity,
      pollSeconds: this.config.FUTURES_POLL_SECONDS,
      accounts: [...this.slots.values()].map(({ id, strategyId, productId, account }) => ({
        id,
        strategy: strategyId,
        productId,
        equity: account.equity,
        returnOnStart: account.equity / equity - 1,
        position: account.openPosition,
        markPrice: account.markPrice,
        openPnl: account.openPosition ? account.openPnl : null,
        pendingEntry: account.pendingEntry !== null,
        halted: account.halted,
        lastBar: iso(account.lastProcessedBarTime),
        ...(stats[id] ?? NO_TRADES),
      })),
      rotation: rotation
        ? {
            id: ROTATION_ID,
            equity: rotation.equity,
            returnOnStart: rotation.equity / equity - 1,
            positions: rotation.positions.map((holding) => {
              const markPrice = rotation.priceOf(holding.productId) ?? holding.averageEntry;
              const move = markPrice - holding.averageEntry;
              return {
                ...holding,
                markPrice,
                openPnl: sign(holding.direction) * holding.size * move,
              };
            }),
            lastDay: iso(rotation.lastProcessedDay),
            longs: rotation.lastPlan?.longs ?? [],
            shorts: rotation.lastPlan?.shorts ?? [],
            ...(stats[ROTATION_ID] ?? NO_TRADES),
          }
        : null,
    };
  }

  /** Each strategy's paper P&L over time, for the dashboard's chart. */
  pnlHistory() {
    const sources: EquitySource[] = [...this.slots.values()].map(({ strategyId, account }) => ({
      strategy: strategyId,
      daily: account.daily,
      equity: account.equity,
    }));
    if (this.rotation) {
      sources.push({ strategy: 'F4', daily: this.rotation.daily, equity: this.rotation.equity });
    }
    const equity = this.config.FUTURES_PAPER_EQUITY;
    return {
      startedAt: iso(this.startedAt),
      paperEquity: equity,
      strategies: pnlHistory(sources, equity, this.startedAt, this.clock()).map((s) => ({
        ...s,
        points: s.points.map((p) => ({ t: iso(p.t), pnl: p.pnl })),
      })),
    };
  }

  private intradayProducts(): string[] {
    return [...new Set([...this.slots.values()].map((s) => s.productId))];
  }

  private async advanceIntraday(productId: string): Promise<void> {
    const slots = [...this.slots.values()].filter((s) => s.productId === productId);
    let series = this.series.get(productId);
    if (!series) this.series.set(productId, (series = new MarketSeries(SERIES_LIMITS)));

    // Open time of the newest bar that closed at least SETTLE_SECONDS ago.
    const newest =
      Math.floor((this.clock() - SETTLE_SECONDS) / FIVE_MINUTES) * FIVE_MINUTES - FIVE_MINUTES;
    let from: number;
    const last = series.m5.at(-1);
    if (last) {
      from = last.t + FIVE_MINUTES;
    } else {
      // Cold start: the longest warmup any strategy needs, from a 4-hour
      // boundary so the bigger bars line up, and back to any account's last
      // bar if it has been down longer than that.
      const warmup = Math.max(...slots.map((s) => INTRADAY_STRATEGIES[s.strategyId].warmupM5Bars));
      from = Math.floor((newest - warmup * FIVE_MINUTES) / FOUR_HOURS) * FOUR_HOURS;
      for (const { account } of slots) {
        const seen = account.lastProcessedBarTime;
        if (seen !== null) from = Math.min(from, seen + FIVE_MINUTES);
      }
      from = Math.floor(from / FOUR_HOURS) * FOUR_HOURS;
    }
    if (from > newest) return;

    const bars = await this.candles.fetch(productId, 'FIVE_MINUTE', from, newest + FIVE_MINUTES);
    if (bars.length === 0) return;
    for (const bar of bars) {
      if (series.now !== null && bar.t < series.now) continue;
      series.append(bar);
      for (const { account } of slots) {
        const seen = account.lastProcessedBarTime;
        if (seen === null || bar.t > seen) account.onBar(bar, series);
      }
    }
    this.store.transaction(() => {
      for (const { id, account } of slots) this.store.saveState(id, account.toState());
      this.writeUnsaved();
    });
  }

  private async advanceRotation(rotation: RotationAccount): Promise<void> {
    // The newest day whose bar closed at least DAILY_SETTLE_SECONDS ago.
    const newest = utcDay(this.clock() - DAILY_SETTLE_SECONDS) - DAY;
    const done = rotation.lastProcessedDay;
    const from = done === null ? newest - ROTATION_HISTORY_DAYS * DAY : done + DAY;
    if (from > newest) return;

    const byProduct = new Map<string, Map<number, Bar>>();
    for (const productId of ROTATION_UNIVERSE) {
      const bars = await this.candles.fetch(productId, 'ONE_DAY', from, newest + DAY);
      byProduct.set(productId, new Map(bars.map((b) => [b.t, b])));
    }
    const before = rotation.trades.length;
    for (let day = from; day <= newest; day += DAY) {
      const today = new Map<string, Bar>();
      for (const [productId, bars] of byProduct) {
        const bar = bars.get(day);
        if (bar) today.set(productId, bar);
      }
      rotation.onDay(day, today);
    }
    for (const trade of rotation.trades.slice(before)) {
      this.unsavedTrades.push([ROTATION_ID, trade]);
      this.event('info', 'closed', `${ROTATION_ID} ${describeTrade(trade)}`);
    }
    const plan = rotation.lastPlan;
    if (plan && rotation.trades.length > before) {
      this.alerter.alert(
        'info',
        'rotation',
        'F4 rebalanced',
        `Long ${plan.longs.join(', ') || 'nothing'}; short ${plan.shorts.join(', ') || 'nothing'}.`,
      );
    }
    this.store.transaction(() => {
      this.store.saveState(ROTATION_ID, rotation.toState());
      this.writeUnsaved();
    });
  }

  private entriesAllowed(decisionTime: number, staleAfter: number): boolean {
    if (existsSync(this.config.FUTURES_KILL_SWITCH_PATH)) return false;
    return this.clock() - decisionTime <= staleAfter;
  }

  private listenerFor(id: string): AccountListener {
    return {
      opened: (p) => {
        const message =
          `${id} opened ${p.direction} ${p.size.toPrecision(6)} at ${p.entryPrice} ` +
          `(stop ${p.stop.toPrecision(8)}, target ${p.target.toPrecision(8)}): ${p.reason}`;
        this.event('info', 'opened', message);
        this.alerter.alert('info', 'opened', `${id} ${p.direction}`, message);
      },
      closed: (trade) => {
        this.unsavedTrades.push([id, trade]);
        const message = `${id} ${describeTrade(trade)}`;
        this.event('info', 'closed', message);
        this.alerter.alert('info', 'closed', `${id} closed`, message);
      },
      halted: (_day, realized) => {
        const message = `${id} lost ${realized.toFixed(2)} today: no new entries until 00:00 UTC`;
        this.event('warning', 'halted', message);
        this.alerter.alert('warning', 'halted', `${id} halted for the day`, message);
      },
    };
  }

  private event(level: Severity, kind: string, message: string): void {
    this.unsavedEvents.push([level, kind, message]);
  }

  /** Write buffered trades and events on their own. */
  private flush(): void {
    this.store.transaction(() => this.writeUnsaved());
  }

  private writeUnsaved(): void {
    for (const [id, trade] of this.unsavedTrades) this.store.insertTrade(id, trade);
    for (const [level, kind, message] of this.unsavedEvents)
      this.store.addEvent(level, kind, message);
    this.unsavedTrades = [];
    this.unsavedEvents = [];
  }
}

function describeTrade(trade: ClosedTrade): string {
  return (
    `closed ${trade.direction} ${trade.productId} by ${trade.exitReason}: ` +
    `${trade.entryPrice} → ${trade.exitPrice}, net ${trade.netPnl.toFixed(2)} ` +
    `(${(trade.returnOnEquity * 100).toFixed(3)}% of equity)`
  );
}
