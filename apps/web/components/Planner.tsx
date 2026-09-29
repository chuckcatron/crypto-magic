'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
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
  type PlannerInputs,
} from '@/lib/planner';
import { PlannerChart, SERIES_STYLE, type ChartSeries } from './PlannerChart';
import { StatTile } from './StatTile';

/** Remembered per browser, as a convenience only: the page works without it. */
const STORAGE_KEY = 'crypto-magic:planner';

interface Field {
  key: keyof PlannerInputs;
  label: string;
  hint: string;
  prefix?: string;
  suffix?: string;
  min: number;
  max: number;
  step: number;
}

const FIELDS: Field[] = [
  {
    key: 'income',
    label: 'Yearly income',
    hint: 'before tax',
    prefix: '$',
    min: 0,
    max: 100_000_000,
    step: 1000,
  },
  {
    key: 'sharePct',
    label: 'Share to replace',
    hint: 'of that income',
    suffix: '%',
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'startBalance',
    label: 'Invested today',
    hint: 'all accounts',
    prefix: '$',
    min: 0,
    max: 100_000_000,
    step: 100,
  },
  {
    key: 'monthly',
    label: 'Added each month',
    hint: 'what you can keep up',
    prefix: '$',
    min: 0,
    max: 1_000_000,
    step: 50,
  },
  {
    key: 'returnPct',
    label: 'Expected return',
    hint: 'per year, after inflation',
    suffix: '%',
    min: -10,
    max: 30,
    step: 0.5,
  },
  {
    key: 'withdrawalPct',
    label: 'Safe withdrawal',
    hint: 'per year, of the balance',
    suffix: '%',
    min: 1,
    max: 10,
    step: 0.5,
  },
  {
    key: 'goalYears',
    label: 'Get there in',
    hint: 'years from now',
    suffix: 'yrs',
    min: 1,
    max: MAX_YEARS,
    step: 1,
  },
];

type Draft = Record<keyof PlannerInputs, string>;

const toDraft = (inputs: PlannerInputs): Draft =>
  Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)])) as Draft;

/** A field's number, or null while it is empty or out of range. */
function parseField(field: Field, raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= field.min && n <= field.max ? n : null;
}

export function Planner() {
  const [draft, setDraft] = useState<Draft>(() => toDraft(DEFAULT_INPUTS));

  // Restore after mount, not during render, so server and client HTML match.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setDraft({ ...toDraft(DEFAULT_INPUTS), ...(JSON.parse(saved) as Partial<Draft>) });
    } catch {
      // Private window or blocked storage: the defaults stand.
    }
  }, []);

  const update = (key: keyof PlannerInputs, value: string) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not saved; nothing else depends on it.
    }
  };

  const values: Partial<PlannerInputs> = {};
  const invalid: (keyof PlannerInputs)[] = [];
  for (const field of FIELDS) {
    const value = parseField(field, draft[field.key]);
    if (value === null) invalid.push(field.key);
    else values[field.key] = value;
  }
  // FIELDS covers every key, so with nothing invalid every value is present.
  const inputs = invalid.length === 0 ? (values as PlannerInputs) : null;

  // A few thousand multiplications; recomputing each render is cheaper than caching.
  const result = (() => {
    if (!inputs) return null;
    const target = targetBalance(inputs);
    const rows = scenarios(inputs.returnPct).map((scenario) => ({
      scenario,
      years: yearsToTarget(inputs.startBalance, inputs.monthly, scenario.schedule, target),
      needed: monthlyNeeded(inputs.startBalance, scenario.schedule, target, inputs.goalYears),
      atGoal: simulate(
        inputs.startBalance,
        inputs.monthly,
        scenario.schedule,
        inputs.goalYears * 12,
      )[inputs.goalYears * 12],
    }));
    const expected = rows[0];
    // Long enough to show the goal year and the expected crossing, with a little after.
    const horizon = Math.min(
      MAX_YEARS,
      Math.max(10, Math.ceil(Math.max(inputs.goalYears, expected.years ?? MAX_YEARS)) + 2),
    );
    const series: ChartSeries[] = rows.map(({ scenario }) => {
      const monthly = simulate(
        inputs.startBalance,
        inputs.monthly,
        scenario.schedule,
        horizon * 12,
      );
      return { scenario, yearly: monthly.filter((_, m) => m % 12 === 0) };
    });
    return { target, rows, expected, series, horizon };
  })();

  const yearlyIncome = inputs ? (inputs.income * inputs.sharePct) / 100 : null;

  return (
    <main className="shell">
      <header className="header">
        <h1 className="brand">Income planner</h1>
        <span className="badge">today&apos;s dollars</span>
        <div className="header-spacer" />
        <Link className="btn" href="/">
          ← Dashboard
        </Link>
      </header>

      <p className="planner-lede">
        How much has to be invested, and for how long, before it can pay you a slice of your income
        every year, including the bad ones. The bot doesn&apos;t change this math: whatever it earns
        is a percentage of what you put in.
      </p>

      <section className="card planner-form" aria-label="Your numbers">
        {FIELDS.map((field) => {
          const bad = invalid.includes(field.key);
          return (
            <label key={field.key} className={bad ? 'field field--bad' : 'field'}>
              <span className="field-label">{field.label}</span>
              <span className="field-input">
                {field.prefix && <span className="field-affix">{field.prefix}</span>}
                <input
                  type="number"
                  inputMode="decimal"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={draft[field.key]}
                  aria-invalid={bad}
                  onChange={(e) => update(field.key, e.target.value)}
                />
                {field.suffix && <span className="field-affix">{field.suffix}</span>}
              </span>
              <span className="field-hint">
                {bad ? `enter ${field.min}–${field.max.toLocaleString('en-US')}` : field.hint}
              </span>
            </label>
          );
        })}
        <button
          type="button"
          className="btn planner-reset"
          onClick={() => {
            setDraft(toDraft(DEFAULT_INPUTS));
            try {
              window.localStorage.removeItem(STORAGE_KEY);
            } catch {
              // Nothing to clear.
            }
          }}
        >
          Reset
        </button>
      </section>

      {!result || !inputs ? (
        <p className="empty">Fix the highlighted fields to see the projection.</p>
      ) : (
        <>
          <div className="tiles planner-tiles">
            <StatTile
              hero
              label="Your goal"
              value={dollars(result.target)}
              sub={`pays ${dollars(yearlyIncome!)}/yr at ${inputs.withdrawalPct}%`}
            />
            <StatTile
              label={`At ${dollars(inputs.monthly)}/month you get there in`}
              value={formatYears(result.expected.years)}
              sub={`strong ${formatYears(result.rows[1].years)} · bad decade ${formatYears(result.rows[2].years)}`}
            />
            <StatTile
              label={`To get there in ${inputs.goalYears} yrs, invest`}
              value={`${dollars(result.expected.needed)}/mo`}
              sub={`${dollars(result.rows[2].needed)}/mo to be safe against a bad decade`}
            />
            <StatTile
              label={`After ${inputs.goalYears} yrs at your current pace`}
              value={dollars(result.expected.atGoal)}
              sub={`pays ${dollars((result.expected.atGoal * inputs.withdrawalPct) / 100)}/yr`}
            />
          </div>

          <section className="card">
            <h2 className="card-title">Balance over {result.horizon} years</h2>
            <div className="legend" aria-hidden="true">
              {result.series.map(({ scenario }) => (
                <span key={scenario.key} className="legend-item">
                  <svg width="22" height="8" viewBox="0 0 22 8">
                    <line
                      x1="1"
                      x2="21"
                      y1="4"
                      y2="4"
                      stroke={SERIES_STYLE[scenario.key].color}
                      strokeWidth="2"
                      strokeDasharray={SERIES_STYLE[scenario.key].dash}
                      strokeLinecap="round"
                    />
                  </svg>
                  {scenario.label} <span className="legend-note">· {scenario.describe}</span>
                </span>
              ))}
            </div>
            <PlannerChart series={result.series} target={result.target} />
          </section>

          <section className="card planner-table">
            <h2 className="card-title">By scenario</h2>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Scenario</th>
                    <th>Return</th>
                    <th className="num">Years to goal at {dollars(inputs.monthly)}/mo</th>
                    <th className="num">Monthly to reach it in {inputs.goalYears} yrs</th>
                    <th className="num">Balance in {inputs.goalYears} yrs</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.scenario.key}>
                      <td className="strong">{row.scenario.label}</td>
                      <td>{row.scenario.describe}</td>
                      <td className="num">{formatYears(row.years)}</td>
                      <td className="num">{dollars(row.needed)}</td>
                      <td className="num">{dollars(row.atGoal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card planner-notes">
            <h2 className="card-title">What this assumes</h2>
            <ul>
              <li>
                <strong>Returns are after inflation,</strong> so every figure is in today&apos;s
                dollars. Broad stock funds have averaged roughly 5–7% a year after inflation over
                the long run; nothing guarantees it.
              </li>
              <li>
                <strong>Steady returns are a simplification.</strong> Real markets swing. The bad
                decade (0% for {BAD_DECADE_YEARS} years) is there because decades like that have
                happened, for example US stocks from 2000 to 2010.
              </li>
              <li>
                <strong>The withdrawal rate is what keeps the money lasting.</strong> About 4% a
                year is the common rule of thumb for a diversified portfolio. Crypto swings far
                harder, so a goal funded mostly by the bot would need a lower rate, and so a bigger
                balance.
              </li>
              <li>
                <strong>No taxes or fees are taken out.</strong> Tax-advantaged accounts (a 401(k)
                match first) change the real numbers a lot.
              </li>
              <li>
                <strong>The bot&apos;s own backtests</strong> ranged from −8% to +79% a year, with
                drops of 30–68%. That is too uneven to plan an income on; treat it as a small slice
                of the total, not the engine of this plan.
              </li>
            </ul>
            <p className="planner-disclaimer">
              A planning calculator, not financial advice. A fee-only fiduciary planner can check it
              against your whole situation.
            </p>
          </section>
        </>
      )}
    </main>
  );
}
