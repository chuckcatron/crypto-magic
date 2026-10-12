import type { MarketSeries } from '../series';
import type { IntradayStrategy } from '../strategies/types';
import {
  DAY,
  FIVE_MINUTES,
  RISK_RULES,
  sign,
  utcDay,
  type Bar,
  type ClosedTrade,
  type CostModel,
  type DailyMark,
  type EntrySignal,
  type ExitReason,
  type OpenPosition,
  type RiskRules,
} from '../types';

export interface IntradayAccountOptions {
  readonly productId: string;
  readonly strategy: IntradayStrategy;
  readonly costs: CostModel;
  readonly rules?: RiskRules;
  readonly initialEquity: number;
  /** No decision before this UNIX second. Earlier bars only warm up the indicators. */
  readonly tradeFrom: number;
  /**
   * Asked before each new entry, with the decision's time (the bar's close).
   * The paper engine says no while its kill switch is on, and for decisions
   * on bars it is only catching up on: a bot that was down could not have
   * made them. Exits are never blocked. Omitted, every entry is allowed, as in
   * the backtest.
   */
  readonly entriesAllowed?: (decisionTime: number) => boolean;
}

/** Hooks for the paper engine: persist, alert. The backtest leaves them unset. */
export interface AccountListener {
  opened?(position: OpenPosition): void;
  closed?(trade: ClosedTrade): void;
  /** The daily loss limit was reached: no new entries until the next UTC day. */
  halted?(day: number, realizedToday: number): void;
}

/** Everything needed to resume after a restart, apart from the trade history. JSON-safe. */
export interface IntradayAccountState {
  readonly cash: number;
  readonly position: OpenPosition | null;
  readonly pending: EntrySignal | null;
  readonly currentDay: number | null;
  readonly dayStartEquity: number;
  readonly dayRealized: number;
  readonly blocked: boolean;
  readonly lastMark: number;
  readonly lastBarTime: number | null;
  readonly daily: DailyMark[];
}

/**
 * One coin's sub-account under EXPERIMENT-008's rules, driven one closed
 * 5-minute bar at a time. The backtest runs it over history; the paper engine
 * runs it over live bars as they close. Same code, same rules.
 *
 * Per bar, in order:
 *   1. a decision made at the previous close fills at this bar's open;
 *   2. the open position is managed: the time stop at the open, then the stop
 *      and target against the bar's range, the stop first if both are touched;
 *   3. equity is marked at the close;
 *   4. the strategy decides at the close, if flat and not halted.
 */
export class IntradayAccount {
  readonly trades: ClosedTrade[] = [];
  readonly daily: DailyMark[] = [];
  listener: AccountListener | undefined;

  private readonly rules: RiskRules;
  private cash: number;
  private position: OpenPosition | null = null;
  private pending: EntrySignal | null = null;
  private currentDay: number | null = null;
  private dayStartEquity: number;
  private dayRealized = 0;
  private blocked = false;
  private lastMark: number;
  private lastBarTime: number | null = null;
  private lastClose: number | null = null;

  constructor(
    private readonly options: IntradayAccountOptions,
    state?: IntradayAccountState,
  ) {
    this.rules = options.rules ?? RISK_RULES;
    this.cash = options.initialEquity;
    this.dayStartEquity = options.initialEquity;
    this.lastMark = options.initialEquity;
    if (state) {
      this.cash = state.cash;
      this.position = state.position;
      this.pending = state.pending;
      this.currentDay = state.currentDay;
      this.dayStartEquity = state.dayStartEquity;
      this.dayRealized = state.dayRealized;
      this.blocked = state.blocked;
      this.lastMark = state.lastMark;
      this.lastBarTime = state.lastBarTime;
      this.daily.push(...state.daily);
    }
  }

  get productId(): string {
    return this.options.productId;
  }

  /** Equity at the last close: cash plus the open position marked to market. */
  get equity(): number {
    return this.lastMark;
  }

  get openPosition(): OpenPosition | null {
    return this.position;
  }

  /** The close the account was last marked at; null until it has seen a bar since starting. */
  get markPrice(): number | null {
    return this.lastClose;
  }

  /** The open position's price P&L at the last mark, before exit costs; 0 when flat. */
  get openPnl(): number {
    return this.lastMark - this.cash;
  }

  get pendingEntry(): EntrySignal | null {
    return this.pending;
  }

  /** True while the daily loss limit blocks new entries. */
  get halted(): boolean {
    return this.blocked;
  }

  /** Open time of the last bar processed, so a restarted engine knows where to resume. */
  get lastProcessedBarTime(): number | null {
    return this.lastBarTime;
  }

  toState(): IntradayAccountState {
    return {
      cash: this.cash,
      position: this.position,
      pending: this.pending,
      currentDay: this.currentDay,
      dayStartEquity: this.dayStartEquity,
      dayRealized: this.dayRealized,
      blocked: this.blocked,
      lastMark: this.lastMark,
      lastBarTime: this.lastBarTime,
      daily: [...this.daily],
    };
  }

  /** Process one closed 5-minute bar. `series` must already contain it. */
  onBar(bar: Bar, series: MarketSeries): void {
    if (this.lastBarTime !== null && bar.t <= this.lastBarTime) {
      throw new Error(`bar ${bar.t} is not after the last processed bar ${this.lastBarTime}`);
    }
    if (series.m5.at(-1) !== bar) {
      throw new Error('append the bar to the series before passing it to the account');
    }
    const active = bar.t >= this.options.tradeFrom;
    if (active) this.rollDay(bar.t);

    // 1. Fill the decision made at the previous close.
    const pending = this.pending;
    this.pending = null;
    if (pending && active && !this.position && (this.options.entriesAllowed?.(bar.t) ?? true)) {
      this.enter(pending, bar);
    }

    // 2. Manage the open position.
    if (this.position) this.manage(this.position, bar);

    // 3. Mark at the close.
    this.lastMark = this.cash + this.unrealized(bar.c);
    this.lastBarTime = bar.t;
    this.lastClose = bar.c;

    // 4. Decide at the close.
    const closeTime = bar.t + FIVE_MINUTES;
    if (
      closeTime >= this.options.tradeFrom &&
      !this.position &&
      !this.blocked &&
      (this.options.entriesAllowed?.(closeTime) ?? true)
    ) {
      const signal = this.options.strategy.evaluate(series);
      if (signal && isUsable(signal, bar.c)) this.pending = signal;
    }
  }

  /** End of a backtest window: close at the last close, paying the exit cost, and mark the day. */
  finish(): void {
    if (this.position && this.lastBarTime !== null && this.lastClose !== null) {
      this.exit(this.position, this.lastClose, this.lastBarTime + FIVE_MINUTES, 'end');
      this.lastMark = this.cash;
    }
    this.pending = null;
    if (this.currentDay !== null) {
      this.daily.push({ day: this.currentDay, equity: this.lastMark });
      this.currentDay = null;
    }
  }

  private rollDay(t: number): void {
    const day = utcDay(t);
    if (this.currentDay === null) {
      this.startDay(day);
      return;
    }
    if (day === this.currentDay) return;
    // A day with no bars at all keeps the previous close's equity.
    for (let d = this.currentDay; d < day; d += DAY) {
      this.daily.push({ day: d, equity: this.lastMark });
    }
    this.startDay(day);
  }

  private startDay(day: number): void {
    this.currentDay = day;
    this.dayStartEquity = this.lastMark;
    this.dayRealized = 0;
    this.blocked = false;
  }

  private enter(signal: EntrySignal, bar: Bar): void {
    const price = bar.o;
    const direction = signal.direction;
    const s = sign(direction);
    const stop = price - s * signal.stopDistance;
    if (!(stop > 0)) return;
    // Flat, so equity is cash.
    const equity = this.cash;
    const byRisk = (this.rules.riskPerTrade * equity) / signal.stopDistance;
    const byCap = (this.rules.maxLeverage * equity) / price;
    const size = Math.min(byRisk, byCap);
    if (!(size > 0) || !Number.isFinite(size)) return;

    const fee = (size * price * this.options.costs.fillBps) / 10_000;
    this.cash -= fee;
    this.position = {
      direction,
      entryTime: bar.t,
      entryPrice: price,
      size,
      stop,
      target: price + s * signal.targetDistance,
      deadline: bar.t + signal.maxHoldSeconds,
      entryFee: fee,
      equityAtEntry: equity,
      reason: signal.reason,
    };
    this.listener?.opened?.(this.position);
  }

  private manage(position: OpenPosition, bar: Bar): void {
    if (bar.t >= position.deadline) {
      this.exit(position, bar.o, bar.t, 'time');
      return;
    }
    const closeTime = bar.t + FIVE_MINUTES;
    if (position.direction === 'LONG') {
      if (bar.l <= position.stop) {
        // Opened through the stop: the order fills at the open, not the stop.
        if (bar.o <= position.stop) this.exit(position, bar.o, bar.t, 'stop');
        else this.exit(position, position.stop, closeTime, 'stop');
      } else if (bar.h >= position.target) {
        this.exit(position, position.target, closeTime, 'target');
      }
    } else if (bar.h >= position.stop) {
      if (bar.o >= position.stop) this.exit(position, bar.o, bar.t, 'stop');
      else this.exit(position, position.stop, closeTime, 'stop');
    } else if (bar.l <= position.target) {
      this.exit(position, position.target, closeTime, 'target');
    }
  }

  private exit(position: OpenPosition, price: number, time: number, reason: ExitReason): void {
    const { costs } = this.options;
    const gross = sign(position.direction) * position.size * (price - position.entryPrice);
    const exitFee = (position.size * price * costs.fillBps) / 10_000;
    const hours = Math.max(0, time - position.entryTime) / 3600;
    const funding =
      (position.size * position.entryPrice * costs.fundingBpsPerHour * hours) / 10_000;
    this.cash += gross - exitFee - funding;
    const net = gross - position.entryFee - exitFee - funding;

    const trade: ClosedTrade = {
      productId: this.options.productId,
      direction: position.direction,
      entryTime: position.entryTime,
      exitTime: time,
      entryPrice: position.entryPrice,
      exitPrice: price,
      size: position.size,
      grossPnl: gross,
      fees: position.entryFee + exitFee,
      funding,
      netPnl: net,
      returnOnEquity: net / position.equityAtEntry,
      exitReason: reason,
      reason: position.reason,
    };
    this.trades.push(trade);
    this.position = null;
    this.listener?.closed?.(trade);

    this.dayRealized += net;
    if (
      !this.blocked &&
      this.currentDay !== null &&
      this.dayRealized <= -this.rules.dailyLossLimit * this.dayStartEquity
    ) {
      this.blocked = true;
      this.listener?.halted?.(this.currentDay, this.dayRealized);
    }
  }

  private unrealized(price: number): number {
    const p = this.position;
    return p ? sign(p.direction) * p.size * (price - p.entryPrice) : 0;
  }
}

function isUsable(signal: EntrySignal, close: number): boolean {
  return (
    Number.isFinite(signal.stopDistance) &&
    Number.isFinite(signal.targetDistance) &&
    signal.stopDistance > 0 &&
    signal.targetDistance > 0 &&
    signal.stopDistance < close &&
    signal.maxHoldSeconds > 0
  );
}
