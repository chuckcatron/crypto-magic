#!/usr/bin/env node
//
// projection — what the play-money account and the Roth IRAs could be worth.
//
//   node scripts/projection.mjs                       defaults (see PLAN below)
//   node scripts/projection.mjs --years 10            longer horizon
//   node scripts/projection.mjs --bot-start 3000      different starting balance
//   node scripts/projection.mjs --returns 0,5,8,12    bot return scenarios, % a year
//   node scripts/projection.mjs --plan my-plan.json   replace the plan from a file
//
// A plan file has the same shape as PLAN below. Deposit schedules are lists of
// { from: "YYYY-MM", amount } steps: each step applies from that month until the
// next step starts.
//
// This is arithmetic, not a forecast. It assumes a steady return every year and
// deposits at month end; real returns are lumpy (our backtests ran from +79% to
// -8% a year), so treat the 5% and 10% rows as the planning cases. Taxes are not
// modeled. It is general planning, not financial advice.
//
// No dependencies, and it never touches the engine, the exchange or `.env`.

import { readFileSync } from 'node:fs';

const PLAN = {
  // First deposit lands in this month.
  firstMonth: '2026-11',
  years: 8,
  bot: {
    start: 2000,
    // $200 until May 2027, $600 after, and the debt snowball's leftover from 2031.
    deposits: [
      { from: '2026-11', amount: 200 },
      { from: '2027-06', amount: 600 },
      { from: '2031-01', amount: 950 },
    ],
  },
  roth: {
    start: 0,
    returnPct: 7, // a broad index fund; the bot cannot be held in an IRA
    // $1,250 a month is about $15k a year, i.e. both Roths at the 2026 limit.
    // Starts when the snowball ends. Move it earlier to see what funding sooner does.
    deposits: [{ from: '2031-01', amount: 1250 }],
  },
  botReturnsPct: [0, 5, 10, 20],
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    const val = argv[++i];
    if (val === undefined) throw new Error(`Missing value for ${a}`);
    out[key] = val;
  }
  return out;
}

function num(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function monthIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12)
    throw new Error(`Bad month "${ym}", want YYYY-MM`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

function monthLabel(idx) {
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

function depositAt(steps, idx) {
  let amount = 0;
  for (const s of steps) if (monthIndex(s.from) <= idx) amount = s.amount;
  return amount;
}

// Balance at the end of each month, deposits at month end.
function simulate({ start, deposits }, annualPct, firstIdx, months) {
  const r = (1 + annualPct / 100) ** (1 / 12) - 1;
  const balances = [];
  let b = start;
  for (let m = 0; m < months; m++) {
    b = b * (1 + r) + depositAt(deposits, firstIdx + m);
    balances.push(b);
  }
  return balances;
}

const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = args.plan ? JSON.parse(readFileSync(args.plan, 'utf8')) : structuredClone(PLAN);
  if (args.years !== undefined) plan.years = num('--years', args.years);
  if (args['bot-start'] !== undefined) plan.bot.start = num('--bot-start', args['bot-start']);
  if (args['roth-return'] !== undefined)
    plan.roth.returnPct = num('--roth-return', args['roth-return']);
  if (args.returns !== undefined)
    plan.botReturnsPct = args.returns.split(',').map((x) => num('--returns', x));

  const firstIdx = monthIndex(plan.firstMonth);
  const months = Math.round(plan.years * 12);
  const last = firstIdx + months - 1;
  const contributed = (acct) =>
    acct.start +
    Array.from({ length: months }, (_, m) => depositAt(acct.deposits, firstIdx + m)).reduce(
      (a, b) => a + b,
      0,
    );

  console.log(`Projection: ${plan.firstMonth} to ${monthLabel(last)} (${plan.years} years)\n`);

  console.log('Deposit schedule (per month)');
  console.log('  from      bot       roth');
  const steps = new Set([...plan.bot.deposits, ...plan.roth.deposits].map((s) => s.from));
  for (const from of [...steps].sort()) {
    const idx = monthIndex(from);
    console.log(
      `  ${from}  ${usd(depositAt(plan.bot.deposits, idx)).padStart(7)}  ${usd(depositAt(plan.roth.deposits, idx)).padStart(7)}`,
    );
  }

  console.log(
    `\nPlay-money account (starts ${usd(plan.bot.start)}, you put in ${usd(contributed(plan.bot))} in total)`,
  );
  console.log('  return   balance at end   income/mo at that return   income/mo at 4%');
  for (const pct of plan.botReturnsPct) {
    const bal = simulate(plan.bot, pct, firstIdx, months).at(-1);
    const atReturn = (bal * pct) / 100 / 12;
    const atFour = (bal * 0.04) / 12;
    console.log(
      `  ${(pct + '%').padEnd(7)}  ${usd(bal).padStart(13)}   ${usd(atReturn).padStart(24)}   ${usd(atFour).padStart(15)}`,
    );
  }

  const roth = simulate(plan.roth, plan.roth.returnPct, firstIdx, months).at(-1);
  console.log(
    `\nRoth IRAs at ${plan.roth.returnPct}% (you put in ${usd(contributed(plan.roth))}): ${usd(roth)} at the end`,
  );

  console.log('\nYear-end play-money balance');
  const header = ['  year', ...plan.botReturnsPct.map((p) => (p + '%').padStart(10))].join(' ');
  console.log(header);
  const series = plan.botReturnsPct.map((p) => simulate(plan.bot, p, firstIdx, months));
  for (let m = 0; m < months; m++) {
    const idx = firstIdx + m;
    if (idx % 12 === 11 || m === months - 1) {
      console.log(
        ['  ' + monthLabel(idx).slice(0, 4), ...series.map((s) => usd(s[m]).padStart(10))].join(
          ' ',
        ),
      );
    }
  }
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
