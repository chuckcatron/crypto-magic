/**
 * Funding-rate carry: long spot, short perpetual, collect funding.
 *
 * Pure simulation over a series of funding payments. Price moves are assumed to
 * cancel between the two legs, which is the point of the trade; what remains is
 * funding received (or paid, when negative) minus the cost of opening and
 * closing both legs. See docs/EXPERIMENT-002-funding-carry.md.
 */

export interface FundingEvent {
  /** Unix seconds. */
  readonly time: number;
  /** Rate for one funding period, as a fraction (0.0001 = 0.01%). Positive: shorts receive. */
  readonly rate: number;
}

export interface CarryConfig {
  /** Capital per unit of notional: spot plus futures margin. 1.5 = 50% margin. */
  readonly capitalMultiple: number;
  /** Cost per side on the spot leg, basis points (fee + slippage). */
  readonly spotCostBps: number;
  /** Cost per side on the perpetual leg, basis points. */
  readonly perpCostBps: number;
  readonly mode: 'always' | 'conditional';
  /** Conditional mode: payments averaged to decide. */
  readonly lookbackEvents: number;
  /** Conditional mode: open when the trailing average, annualized, is at least this (percent). */
  readonly enterAnnualizedPct: number;
  /** Conditional mode: close when the trailing average, annualized, falls below this (percent). */
  readonly exitAnnualizedPct: number;
  /** Funding payments per year: 1,095 for 8-hourly. */
  readonly periodsPerYear: number;
}

export interface CarryResult {
  readonly startTime: number;
  readonly endTime: number;
  /** Net, on capital, compounded, after every cost. The number that answers "is it income?". */
  readonly netAnnualizedPct: number;
  /** Funding alone, on notional, while held, annualized over the whole window. */
  readonly grossFundingAnnualizedPct: number;
  readonly totalCostPct: number;
  /** Opens plus closes. Each one pays the round-trip leg costs. */
  readonly switches: number;
  readonly timeInCarryPct: number;
  /** Share of payments in the window that were negative (the short would have paid). */
  readonly negativeSharePct: number;
  /** Worst 30-day stretch of income on capital while held. */
  readonly worst30DayPct: number;
  readonly finalEquity: number;
}

export function runCarry(events: readonly FundingEvent[], config: CarryConfig): CarryResult {
  if (events.length < 2) throw new Error('carry backtest needs at least two funding payments');
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.time <= events[i - 1]!.time) throw new Error('funding payments must be strictly ascending');
  }

  const legCost = (config.spotCostBps + config.perpCostBps) / 10_000;
  const initial = 1;
  let equity = initial;
  let holding = false;
  let switches = 0;
  let costs = 0;
  let grossFunding = 0;
  let heldPayments = 0;
  const incomeOnCapital: number[] = []; // per payment, 0 when flat

  const open = () => {
    const cost = (equity / config.capitalMultiple) * legCost;
    equity -= cost;
    costs += cost;
    switches++;
    holding = true;
  };
  const close = () => {
    const cost = (equity / config.capitalMultiple) * legCost;
    equity -= cost;
    costs += cost;
    switches++;
    holding = false;
  };

  if (config.mode === 'always') open();

  for (let i = 0; i < events.length; i++) {
    // Conditional mode decides BEFORE payment i, using only payments strictly
    // before it. Holding at payment i means receiving payment i.
    if (config.mode === 'conditional' && i >= config.lookbackEvents) {
      let sum = 0;
      for (let k = i - config.lookbackEvents; k < i; k++) sum += events[k]!.rate;
      const annualizedPct = (sum / config.lookbackEvents) * config.periodsPerYear * 100;
      if (!holding && annualizedPct >= config.enterAnnualizedPct) open();
      else if (holding && annualizedPct < config.exitAnnualizedPct) close();
    }

    if (holding) {
      const notional = equity / config.capitalMultiple;
      const income = notional * events[i]!.rate;
      equity += income;
      grossFunding += events[i]!.rate;
      heldPayments++;
      incomeOnCapital.push(income / (equity - income));
    } else {
      incomeOnCapital.push(0);
    }
  }

  if (holding) close();

  const years = (events.at(-1)!.time - events[0]!.time) / (365 * 86_400);
  const window = Math.min(incomeOnCapital.length, Math.round((config.periodsPerYear * 30) / 365));
  let worst = Number.POSITIVE_INFINITY;
  for (let i = 0; i + window <= incomeOnCapital.length; i++) {
    let s = 0;
    for (let k = i; k < i + window; k++) s += incomeOnCapital[k]!;
    worst = Math.min(worst, s);
  }

  return {
    startTime: events[0]!.time,
    endTime: events.at(-1)!.time,
    netAnnualizedPct: years > 0 && equity > 0 ? (Math.pow(equity / initial, 1 / years) - 1) * 100 : 0,
    grossFundingAnnualizedPct: years > 0 ? (grossFunding / years) * 100 : 0,
    totalCostPct: (costs / initial) * 100,
    switches,
    timeInCarryPct: (heldPayments / events.length) * 100,
    negativeSharePct: (events.filter((e) => e.rate < 0).length / events.length) * 100,
    worst30DayPct: Number.isFinite(worst) ? worst * 100 : 0,
    finalEquity: equity,
  };
}

/** The pre-registered configuration from docs/EXPERIMENT-002-funding-carry.md. */
export const EXPERIMENT_002_CONFIG: Omit<CarryConfig, 'mode'> = {
  capitalMultiple: 1.5,
  spotCostBps: 65,
  perpCostBps: 5,
  lookbackEvents: 9,
  enterAnnualizedPct: 10,
  exitAnnualizedPct: 0,
  periodsPerYear: 1095,
};
