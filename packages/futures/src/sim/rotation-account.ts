import {
  DAY,
  sign,
  type Bar,
  type ClosedTrade,
  type CostModel,
  type DailyMark,
  type Direction,
  type ExitReason,
} from '../types';

export interface RotationOptions {
  readonly costs: CostModel;
  readonly initialEquity: number;
  /** First UNIX second (a UTC midnight) at which the account may trade. */
  readonly tradeFrom: number;
  /** Days of return the ranking uses. */
  readonly lookbackDays?: number;
  /** Fewer eligible coins than this and the account holds nothing. */
  readonly minCoins?: number;
  /** Disaster stop, as a fraction against the price of the most recent fill. */
  readonly stopFraction?: number;
  /** Long notional + short notional, as a multiple of equity, set at each rebalance. */
  readonly grossExposure?: number;
  /**
   * Asked at each rebalance with the decision's time (the Sunday close). When
   * it says no, the rebalance only closes and shrinks positions; nothing is
   * opened or grown. The paper engine's kill switch and catch-up rule. Omitted,
   * everything is allowed, as in the backtest.
   */
  readonly entriesAllowed?: (decisionTime: number) => boolean;
}

/** Everything needed to resume after a restart. JSON-safe. */
export interface RotationAccountState {
  readonly cash: number;
  readonly holdings: readonly Holding[];
  /** Recent closes per coin, enough for the ranking. */
  readonly closes: readonly (readonly [string, readonly (readonly [number, number])[]])[];
  readonly lastClose: readonly (readonly [string, number])[];
  readonly plan: RotationPlan | null;
  readonly lastDay: number | null;
  readonly daily: readonly DailyMark[];
}

export interface RotationPlan {
  readonly longs: readonly string[];
  readonly shorts: readonly string[];
  /** The eligible coins and their lookback returns, best first. */
  readonly ranking: readonly { readonly productId: string; readonly ret: number }[];
}

export interface Holding {
  readonly productId: string;
  readonly direction: Direction;
  size: number;
  averageEntry: number;
  stop: number;
  readonly openedAt: number;
  readonly firstEntryPrice: number;
  readonly equityAtEntry: number;
  fees: number;
  funding: number;
  /** P&L realized by trimming the position at rebalances. */
  realized: number;
}

/**
 * F4 — cross-sectional momentum across many coins (EXPERIMENT-008), driven one
 * UTC day at a time.
 *
 * At each Sunday close, the coins with a close on each of the previous 22 days
 * are ranked by 21-day return. With N of them (at least 6), the top ⌊N/3⌋ are
 * held long and the bottom ⌊N/3⌋ short, each with 0.5 ÷ ⌊N/3⌋ of equity, filled
 * at Monday's open. A position that stays in its leg is resized; any other is
 * closed. Each position has a disaster stop 20% against its most recent fill,
 * judged on daily highs and lows. A stopped coin sits out until the next
 * rebalance.
 *
 * Per day, in order: rebalance at the open, charge a day's funding on the
 * positions held, check stops on the day's range, mark at the close, and on a
 * Sunday plan Monday's rebalance.
 */
export class RotationAccount {
  readonly trades: ClosedTrade[] = [];
  readonly daily: DailyMark[] = [];
  /** The last plan made, for reporting. */
  lastPlan: RotationPlan | null = null;

  private cash: number;
  private readonly holdings = new Map<string, Holding>();
  private readonly closes = new Map<string, Map<number, number>>();
  private readonly lastClose = new Map<string, number>();
  private plan: RotationPlan | null = null;
  private lastDay: number | null = null;
  private readonly lookbackDays: number;
  private readonly minCoins: number;
  private readonly stopFraction: number;
  private readonly grossExposure: number;

  constructor(
    private readonly options: RotationOptions,
    state?: RotationAccountState,
  ) {
    this.cash = options.initialEquity;
    this.lookbackDays = options.lookbackDays ?? 21;
    this.minCoins = options.minCoins ?? 6;
    this.stopFraction = options.stopFraction ?? 0.2;
    this.grossExposure = options.grossExposure ?? 1;
    if (state) {
      this.cash = state.cash;
      for (const holding of state.holdings) this.holdings.set(holding.productId, { ...holding });
      for (const [productId, closes] of state.closes) this.closes.set(productId, new Map(closes));
      for (const [productId, close] of state.lastClose) this.lastClose.set(productId, close);
      this.plan = state.plan;
      this.lastPlan = state.plan;
      this.lastDay = state.lastDay;
      this.daily.push(...state.daily);
    }
  }

  /** The last UTC day processed, so a restarted engine knows where to resume. */
  get lastProcessedDay(): number | null {
    return this.lastDay;
  }

  toState(): RotationAccountState {
    // The ranking reads lookbackDays + 1 closes; keep a little more.
    const since = (this.lastDay ?? 0) - (this.lookbackDays + 10) * DAY;
    return {
      cash: this.cash,
      holdings: [...this.holdings.values()].map((h) => ({ ...h })),
      closes: [...this.closes.entries()].map(
        ([productId, series]) =>
          [productId, [...series.entries()].filter(([day]) => day >= since)] as const,
      ),
      lastClose: [...this.lastClose.entries()],
      plan: this.plan,
      lastDay: this.lastDay,
      daily: [...this.daily],
    };
  }

  get equity(): number {
    return this.cash + this.unrealized((id) => this.lastClose.get(id));
  }

  get positions(): readonly Readonly<Holding>[] {
    return [...this.holdings.values()];
  }

  /** Feed one UTC day: every coin's daily bar that opened at `day` (00:00 UTC). */
  onDay(day: number, bars: ReadonlyMap<string, Bar>): void {
    if (day % DAY !== 0) throw new Error(`a day must start at 00:00 UTC, got ${day}`);
    if (this.lastDay !== null && day <= this.lastDay) {
      throw new Error(`day ${day} is not after the last day ${this.lastDay}`);
    }
    for (const [productId, bar] of bars) {
      if (bar.t !== day) throw new Error(`${productId} bar opens at ${bar.t}, not ${day}`);
      let series = this.closes.get(productId);
      if (!series) this.closes.set(productId, (series = new Map<number, number>()));
      series.set(day, bar.c);
    }

    if (day >= this.options.tradeFrom) {
      if (this.plan) this.rebalance(this.plan, day, bars);
      this.plan = null;
      this.chargeFunding(bars);
      for (const holding of [...this.holdings.values()]) {
        const bar = bars.get(holding.productId);
        if (bar) this.checkStop(holding, bar, day);
      }
      this.markDay(day, bars);
    }

    for (const [productId, bar] of bars) this.lastClose.set(productId, bar.c);

    // Sunday's close is Monday 00:00: plan the rebalance that fills at Monday's open.
    if (new Date(day * 1000).getUTCDay() === 0 && day + DAY >= this.options.tradeFrom) {
      this.plan = this.rank(day);
      this.lastPlan = this.plan;
    }
    this.lastDay = day;
  }

  /** End of a backtest window: close everything at the last closes, paying the exit cost. */
  finish(): void {
    if (this.lastDay === null) return;
    for (const holding of [...this.holdings.values()]) {
      const price = this.lastClose.get(holding.productId)!;
      this.close(holding, price, this.lastDay + DAY, 'end');
    }
    const last = this.daily.at(-1);
    if (last && last.day === this.lastDay)
      this.daily[this.daily.length - 1] = { day: last.day, equity: this.cash };
  }

  /** Rank on the close of `day`. */
  rank(day: number): RotationPlan {
    const ranking: { productId: string; ret: number }[] = [];
    for (const [productId, series] of this.closes) {
      let complete = true;
      for (let n = 0; n <= this.lookbackDays; n++) {
        if (!series.has(day - n * DAY)) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      const now = series.get(day)!;
      const then = series.get(day - this.lookbackDays * DAY)!;
      ranking.push({ productId, ret: now / then - 1 });
    }
    ranking.sort((a, b) => b.ret - a.ret || a.productId.localeCompare(b.productId));
    if (ranking.length < this.minCoins) return { longs: [], shorts: [], ranking };
    const k = Math.floor(ranking.length / 3);
    return {
      longs: ranking.slice(0, k).map((r) => r.productId),
      shorts: ranking.slice(-k).map((r) => r.productId),
      ranking,
    };
  }

  private rebalance(plan: RotationPlan, day: number, bars: ReadonlyMap<string, Bar>): void {
    const openOf = (id: string) => bars.get(id)?.o;
    const equity = this.cash + this.unrealized((id) => openOf(id) ?? this.lastClose.get(id));

    const wanted = new Map<string, Direction>();
    for (const id of plan.longs) wanted.set(id, 'LONG');
    for (const id of plan.shorts) wanted.set(id, 'SHORT');

    for (const holding of [...this.holdings.values()]) {
      if (wanted.get(holding.productId) !== holding.direction) {
        const price = openOf(holding.productId) ?? this.lastClose.get(holding.productId)!;
        this.close(holding, price, day, 'rebalance');
      }
    }

    const legs = plan.longs.length;
    if (legs === 0) return;
    // The plan was made at the Sunday close, which is this day's 00:00.
    const mayGrow = this.options.entriesAllowed?.(day) ?? true;
    const notional = (this.grossExposure * equity * 0.5) / legs;
    for (const [productId, direction] of wanted) {
      const price = openOf(productId);
      // No bar today: it cannot be traded, so it sits out until next week.
      if (price === undefined) continue;
      const size = notional / price;
      const holding = this.holdings.get(productId);
      if (holding) {
        if (mayGrow || size < holding.size) this.resize(holding, size, price);
      } else if (mayGrow) {
        this.open(productId, direction, size, price, day, equity);
      }
    }
  }

  private open(
    productId: string,
    direction: Direction,
    size: number,
    price: number,
    day: number,
    equity: number,
  ): void {
    const fee = this.fee(size, price);
    this.cash -= fee;
    this.holdings.set(productId, {
      productId,
      direction,
      size,
      averageEntry: price,
      stop: this.stopFor(direction, price),
      openedAt: day,
      firstEntryPrice: price,
      equityAtEntry: equity,
      fees: fee,
      funding: 0,
      realized: 0,
    });
  }

  private resize(holding: Holding, size: number, price: number): void {
    const delta = size - holding.size;
    const fee = this.fee(Math.abs(delta), price);
    this.cash -= fee;
    holding.fees += fee;
    if (delta < 0) {
      const realized = sign(holding.direction) * -delta * (price - holding.averageEntry);
      this.cash += realized;
      holding.realized += realized;
    } else if (delta > 0) {
      holding.averageEntry = (holding.size * holding.averageEntry + delta * price) / size;
    }
    holding.size = size;
    holding.stop = this.stopFor(holding.direction, price);
  }

  private close(holding: Holding, price: number, time: number, reason: ExitReason): void {
    const realized = sign(holding.direction) * holding.size * (price - holding.averageEntry);
    const fee = this.fee(holding.size, price);
    this.cash += realized - fee;
    const gross = holding.realized + realized;
    const fees = holding.fees + fee;
    const net = gross - fees - holding.funding;
    this.trades.push({
      productId: holding.productId,
      direction: holding.direction,
      entryTime: holding.openedAt,
      exitTime: time,
      entryPrice: holding.firstEntryPrice,
      exitPrice: price,
      size: holding.size,
      grossPnl: gross,
      fees,
      funding: holding.funding,
      netPnl: net,
      returnOnEquity: net / holding.equityAtEntry,
      exitReason: reason,
      reason: `${holding.direction === 'LONG' ? 'top' : 'bottom'} third by ${this.lookbackDays}-day return`,
    });
    this.holdings.delete(holding.productId);
  }

  private checkStop(holding: Holding, bar: Bar, day: number): void {
    const closeTime = day + DAY;
    if (holding.direction === 'LONG' && bar.l <= holding.stop) {
      if (bar.o <= holding.stop) this.close(holding, bar.o, day, 'stop');
      else this.close(holding, holding.stop, closeTime, 'stop');
    } else if (holding.direction === 'SHORT' && bar.h >= holding.stop) {
      if (bar.o >= holding.stop) this.close(holding, bar.o, day, 'stop');
      else this.close(holding, holding.stop, closeTime, 'stop');
    }
  }

  /** A full day's funding on every position held at the open, whichever side it is on. */
  private chargeFunding(bars: ReadonlyMap<string, Bar>): void {
    const rate = (this.options.costs.fundingBpsPerHour * 24) / 10_000;
    for (const holding of this.holdings.values()) {
      const price = bars.get(holding.productId)?.o ?? this.lastClose.get(holding.productId)!;
      const funding = holding.size * price * rate;
      this.cash -= funding;
      holding.funding += funding;
    }
  }

  private markDay(day: number, bars: ReadonlyMap<string, Bar>): void {
    const previous = this.lastDay;
    const equity = this.cash + this.unrealized((id) => bars.get(id)?.c ?? this.lastClose.get(id));
    // A calendar gap (no bars at all) keeps the previous equity for the missing days.
    if (previous !== null && previous >= this.options.tradeFrom) {
      const carried = this.daily.at(-1)?.equity ?? this.options.initialEquity;
      for (let d = previous + DAY; d < day; d += DAY) this.daily.push({ day: d, equity: carried });
    }
    this.daily.push({ day, equity });
  }

  private unrealized(priceOf: (productId: string) => number | undefined): number {
    let total = 0;
    for (const holding of this.holdings.values()) {
      const price = priceOf(holding.productId) ?? holding.averageEntry;
      total += sign(holding.direction) * holding.size * (price - holding.averageEntry);
    }
    return total;
  }

  private stopFor(direction: Direction, price: number): number {
    return direction === 'LONG' ? price * (1 - this.stopFraction) : price * (1 + this.stopFraction);
  }

  private fee(size: number, price: number): number {
    return (size * price * this.options.costs.fillBps) / 10_000;
  }
}
