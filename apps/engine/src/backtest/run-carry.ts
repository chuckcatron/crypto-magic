/**
 * Funding-carry backtest runner for docs/EXPERIMENT-002-funding-carry.md.
 *
 *   pnpm --filter @crypto-magic/engine exec tsx src/backtest/run-carry.ts \
 *     --csv funding.csv --from 2020-01-01 --to 2022-01-01 --cash-yield 0.2
 *
 * Reads "Symbol,Date,Funding Rate" CSVs as published by
 * supervik/historical-funding-rates-fetcher.
 */
import { readFileSync } from 'node:fs';
import { EXPERIMENT_002_CONFIG, runCarry, type CarryResult, type FundingEvent } from '@crypto-magic/core';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const csv = arg('csv');
if (!csv) throw new Error('--csv is required');
const from = Date.parse(`${arg('from') ?? '1970-01-01'}T00:00:00Z`) / 1000;
const to = Date.parse(`${arg('to') ?? '2100-01-01'}T00:00:00Z`) / 1000;
const cashYield = Number(arg('cash-yield') ?? 'NaN');

const events: FundingEvent[] = readFileSync(csv, 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [, date, rate] = line.split(',');
    return { time: Date.parse(`${date!.trim().replace(' ', 'T')}Z`) / 1000, rate: Number(rate) };
  })
  .filter((e) => Number.isFinite(e.time) && Number.isFinite(e.rate) && e.time >= from && e.time < to)
  .sort((a, b) => a.time - b.time);

const always = runCarry(events, { ...EXPERIMENT_002_CONFIG, mode: 'always' });
const conditional = runCarry(events, { ...EXPERIMENT_002_CONFIG, mode: 'conditional' });

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const verdict = (r: CarryResult) =>
  Number.isFinite(cashYield) ? (r.netAnnualizedPct > cashYield ? 'PASS' : 'FAIL') : '—';

const row = (label: string, a: string, b: string) => `    ${label.padEnd(30)}${a.padStart(12)}   ${b.padStart(12)}`;
process.stdout.write(
  [
    '',
    `  Funding carry · ${day(events[0]!.time)} → ${day(events.at(-1)!.time)} · ${events.length} payments`,
    `  capital ${EXPERIMENT_002_CONFIG.capitalMultiple}x notional · spot ${EXPERIMENT_002_CONFIG.spotCostBps}bps + perp ${EXPERIMENT_002_CONFIG.perpCostBps}bps per side`,
    '',
    `                                      always on    conditional`,
    row('Net yield on capital /yr', pct(always.netAnnualizedPct), pct(conditional.netAnnualizedPct)),
    row('Funding on notional /yr', pct(always.grossFundingAnnualizedPct), pct(conditional.grossFundingAnnualizedPct)),
    row('Total costs', `${always.totalCostPct.toFixed(2)}%`, `${conditional.totalCostPct.toFixed(2)}%`),
    row('Opens + closes', String(always.switches), String(conditional.switches)),
    row('Time in the trade', `${always.timeInCarryPct.toFixed(0)}%`, `${conditional.timeInCarryPct.toFixed(0)}%`),
    row('Worst 30 days (on capital)', pct(always.worst30DayPct), pct(conditional.worst30DayPct)),
    row('Payments that were negative', `${always.negativeSharePct.toFixed(0)}%`, `${always.negativeSharePct.toFixed(0)}%`),
    '',
    Number.isFinite(cashYield) ? row(`vs cash yield ${cashYield}%/yr`, verdict(always), verdict(conditional)) : '',
    '',
  ].join('\n'),
);
