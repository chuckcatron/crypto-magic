import { describe, expect, it } from 'vitest';
import {
  BAD_DECADE_YEARS,
  DEFAULT_INPUTS,
  MAX_YEARS,
  dollars,
  formatYears,
  monthlyNeeded,
  scenarios,
  simulate,
  targetBalance,
  yearsToTarget,
} from './planner';

const flat = (r: number) => () => r;

describe('targetBalance', () => {
  it('pays a quarter of $200k at 4% from $1.25M', () => {
    expect(targetBalance({ income: 200_000, sharePct: 25, withdrawalPct: 4 })).toBe(1_250_000);
  });

  it('is unreachable at a 0% withdrawal rate', () => {
    expect(targetBalance({ income: 100_000, sharePct: 25, withdrawalPct: 0 })).toBe(Infinity);
  });
});

describe('simulate', () => {
  it('just adds deposits at 0%', () => {
    expect(simulate(1_000, 500, flat(0), 24).at(-1)).toBeCloseTo(13_000, 6);
  });

  it('compounds to the stated yearly return, not r/12 compounded', () => {
    expect(simulate(1_000, 0, flat(0.07), 12).at(-1)).toBeCloseTo(1_070, 6);
  });

  it('returns month 0 through the last month', () => {
    expect(simulate(1, 0, flat(0), 36)).toHaveLength(37);
  });

  it('follows a schedule that changes by year', () => {
    const b = simulate(1_000, 0, (year) => (year === 0 ? 0 : 0.1), 24);
    expect(b[12]).toBeCloseTo(1_000, 6);
    expect(b[24]).toBeCloseTo(1_100, 6);
  });
});

describe('yearsToTarget', () => {
  it('is zero when already there', () => {
    expect(yearsToTarget(2_000_000, 0, flat(0.07), 1_000_000)).toBe(0);
  });

  it('matches plain arithmetic at 0%', () => {
    expect(yearsToTarget(0, 1_000, flat(0), 120_000)).toBe(10);
  });

  it('puts $500/month at 7% decades away from $1.25M', () => {
    const years = yearsToTarget(1_000, 500, flat(0.07), 1_250_000)!;
    expect(years).toBeGreaterThan(38);
    expect(years).toBeLessThan(42);
  });

  it('gives up past the horizon', () => {
    expect(yearsToTarget(0, 1, flat(0), 1_000_000)).toBeNull();
    expect(formatYears(null)).toBe(`${MAX_YEARS}+ yrs`);
  });
});

describe('monthlyNeeded', () => {
  it('lands exactly on the target when deposited', () => {
    const schedule = flat(0.07);
    const needed = monthlyNeeded(1_000, schedule, 1_250_000, 20);
    expect(simulate(1_000, needed, schedule, 240).at(-1)).toBeCloseTo(1_250_000, 4);
  });

  it('is exact for an uneven schedule too', () => {
    const bad = scenarios(7).find((s) => s.key === 'bad')!.schedule;
    const needed = monthlyNeeded(1_000, bad, 1_250_000, 20);
    expect(simulate(1_000, needed, bad, 240).at(-1)).toBeCloseTo(1_250_000, 4);
  });

  it('is zero when current savings already get there', () => {
    expect(monthlyNeeded(1_000_000, flat(0.07), 1_250_000, 20)).toBe(0);
  });

  it('costs more after a bad decade than at the expected return', () => {
    const [expected, strong, bad] = scenarios(7).map((s) =>
      monthlyNeeded(1_000, s.schedule, 1_250_000, 20),
    );
    expect(strong).toBeLessThan(expected);
    expect(bad).toBeGreaterThan(expected);
  });
});

describe('scenarios', () => {
  it('earns nothing in the bad decade, then the expected return', () => {
    const bad = scenarios(7).find((s) => s.key === 'bad')!.schedule;
    expect(bad(0)).toBe(0);
    expect(bad(BAD_DECADE_YEARS - 1)).toBe(0);
    expect(bad(BAD_DECADE_YEARS)).toBeCloseTo(0.07);
  });
});

describe('formatting', () => {
  it.each([
    [1_250_000, '$1.25M'],
    [640_000.4, '$640,000'],
    [Infinity, '—'],
  ])('dollars(%d) reads %s', (n, text) => {
    expect(dollars(n)).toBe(text);
  });

  it('rounds years to the half', () => {
    expect(formatYears(37.1)).toBe('37 yrs');
    expect(formatYears(37.3)).toBe('37.5 yrs');
    expect(formatYears(1)).toBe('1 yr');
  });

  it('ships defaults that match the conversation that asked for it', () => {
    expect(targetBalance(DEFAULT_INPUTS)).toBe(1_250_000);
  });
});
