/**
 * Income planner math. Pure, so it is tested without a DOM.
 *
 * Answers one question: how much must be invested, for how long, before the
 * account can pay out a chosen slice of income every year, including the bad
 * ones. Returns are meant to be real (after inflation), so every figure is in
 * today's dollars.
 */

/** Never project further than this; past it the answer is "not in a working life". */
export const MAX_YEARS = 60;

/** How long the "bad first decade" scenario earns nothing. */
export const BAD_DECADE_YEARS = 10;

/** How much better the "strong" scenario does than the expected return, in points. */
export const STRONG_EXTRA_PCT = 3;

export interface PlannerInputs {
  /** Gross yearly income. */
  income: number;
  /** Share of income to replace, percent. */
  sharePct: number;
  /** Yearly withdrawal the account must sustain, percent of the balance. */
  withdrawalPct: number;
  /** Already invested today. */
  startBalance: number;
  /** Added every month. */
  monthly: number;
  /** Expected yearly return after inflation, percent. */
  returnPct: number;
  /** When you want to get there, in years. */
  goalYears: number;
}

export const DEFAULT_INPUTS: PlannerInputs = {
  income: 200_000,
  sharePct: 25,
  withdrawalPct: 4,
  startBalance: 1_000,
  monthly: 500,
  returnPct: 7,
  goalYears: 20,
};

/** Yearly return, as a fraction, in year `year` (0-based). */
export type ReturnSchedule = (year: number) => number;

export interface Scenario {
  key: 'expected' | 'strong' | 'bad';
  label: string;
  /** For tight spots, such as the chart's end labels on a phone. */
  short: string;
  describe: string;
  schedule: ReturnSchedule;
}

export function scenarios(returnPct: number): Scenario[] {
  const r = returnPct / 100;
  const strong = (returnPct + STRONG_EXTRA_PCT) / 100;
  return [
    {
      key: 'expected',
      label: 'Expected',
      short: 'Expected',
      describe: `${returnPct}% a year, every year`,
      schedule: () => r,
    },
    {
      key: 'strong',
      label: 'Strong',
      short: 'Strong',
      describe: `${returnPct + STRONG_EXTRA_PCT}% a year, every year`,
      schedule: () => strong,
    },
    {
      key: 'bad',
      label: 'Bad first decade',
      short: 'Bad decade',
      describe: `0% for ${BAD_DECADE_YEARS} years, then ${returnPct}%`,
      schedule: (year) => (year < BAD_DECADE_YEARS ? 0 : r),
    },
  ];
}

/** The balance that pays `sharePct` of income at `withdrawalPct` a year. */
export function targetBalance(
  inputs: Pick<PlannerInputs, 'income' | 'sharePct' | 'withdrawalPct'>,
) {
  if (inputs.withdrawalPct <= 0) return Number.POSITIVE_INFINITY;
  return (inputs.income * inputs.sharePct) / inputs.withdrawalPct;
}

/**
 * Month-end balances, month 0 (today) to `months`. Deposits land at the end of
 * each month, after that month's growth. A yearly rate compounds to the same
 * yearly figure over twelve months, rather than the slightly higher r/12.
 */
export function simulate(
  startBalance: number,
  monthly: number,
  schedule: ReturnSchedule,
  months: number,
): number[] {
  const balances = [startBalance];
  let balance = startBalance;
  for (let m = 0; m < months; m++) {
    const monthlyRate = (1 + schedule(Math.floor(m / 12))) ** (1 / 12) - 1;
    balance = balance * (1 + monthlyRate) + monthly;
    balances.push(balance);
  }
  return balances;
}

/** Years (in whole months, as a fraction) until the balance reaches `target`, or null past MAX_YEARS. */
export function yearsToTarget(
  startBalance: number,
  monthly: number,
  schedule: ReturnSchedule,
  target: number,
): number | null {
  if (startBalance >= target) return 0;
  const balances = simulate(startBalance, monthly, schedule, MAX_YEARS * 12);
  const month = balances.findIndex((b) => b >= target);
  return month < 0 ? null : month / 12;
}

/**
 * Monthly deposit that reaches `target` in exactly `years`.
 *
 * The final balance is linear in the deposit — growth of what you have now,
 * plus the deposit times what one dollar a month grows to — so it is solved
 * exactly for any return schedule. Zero when what you have already gets there.
 */
export function monthlyNeeded(
  startBalance: number,
  schedule: ReturnSchedule,
  target: number,
  years: number,
): number {
  const months = Math.round(years * 12);
  if (months <= 0) return startBalance >= target ? 0 : Number.POSITIVE_INFINITY;
  const fromStart = simulate(startBalance, 0, schedule, months)[months];
  const perDollar = simulate(0, 1, schedule, months)[months];
  return Math.max(0, (target - fromStart) / perDollar);
}

/** "8 yrs", "8.5 yrs", or "60+ yrs" for null. */
export function formatYears(years: number | null): string {
  if (years === null) return `${MAX_YEARS}+ yrs`;
  const rounded = Math.round(years * 2) / 2;
  return `${rounded} ${rounded === 1 ? 'yr' : 'yrs'}`;
}

/** Whole dollars, compacted past a million: "$1.25M", "$640,000". */
export function dollars(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) {
    return `$${(n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  }
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
