// Run with: node --test scripts/maker-orders.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulate, events, bootstrap, rng } from './maker-orders.mjs';

const US = 1_000_000;
const DAY = 86_400 * US;
const M0 = Math.floor(1_760_000_000_000_000 / DAY) * DAY; // a UTC midnight, in us

async function* from(rows) {
  yield* rows;
}

/** One event day with a known tape. P0 = 100, P_ref = 100, P_H = 101. */
const tape = [
  [M0 - 5 * US, 100], // last trade before midnight: the limit price
  [M0 - 30 * US, 99], // an earlier one, which must not be used
  [M0 + 1 * US, 100], // first trade at or after midnight: P_ref (equal to P0, so not through it)
  [M0 + 600 * US, 99.9], // through a buy limit at 100
  [M0 + 1200 * US, 100], // touches both limits exactly
  [M0 + 3600 * US + 5 * US, 101], // first trade at or after 01:00: P_H
  [M0 + 3600 * US + 9 * US, 150], // later trade, must not be used for P_H
  [M0 + DAY + 2 * US, 102], // next day's P_ref, used only for the day's return
];

test('hand-worked day: strict fills a buy but not a sell; touch fills both', async () => {
  const days = await accumulate(from(tape), M0, M0);
  const [e] = events(days, M0, M0);

  // Strict. Buy fills (99.9 < 100): pays 100 * 1.004 = 100.4, cost vs 100.
  assert.equal(e.strict.buyFilled, true);
  const buyCost = ((100.4 - 100) / 100) * 10_000;
  assert.ok(Math.abs(e.strict.buySaving - (65 - buyCost)) < 1e-9);
  // Sell: no trade strictly above 100 inside the hour (101 is after it), so it
  // crosses at 101 and receives 101 * (1 - 0.0065).
  assert.equal(e.strict.sellFilled, false);
  const sellCost = ((100 - 101 * (1 - 0.0065)) / 100) * 10_000;
  assert.ok(Math.abs(e.strict.sellSaving - (65 - sellCost)) < 1e-9);

  // Touch. The trade at exactly 100 fills the sell at 100 * (1 - 0.004).
  assert.equal(e.touch.sellFilled, true);
  const touchSellCost = ((100 - 100 * (1 - 0.004)) / 100) * 10_000;
  assert.ok(Math.abs(e.touch.sellSaving - (65 - touchSellCost)) < 1e-9);

  assert.ok(Math.abs(e.dayReturn - (102 / 100 - 1)) < 1e-12);
});

test('row order does not matter', async () => {
  const shuffled = [...tape].reverse();
  const a = events(await accumulate(from(tape), M0, M0), M0, M0);
  const b = events(await accumulate(from(shuffled), M0, M0), M0, M0);
  assert.deepEqual(a, b);
});

test('a trade after the hour never fills the limit', async () => {
  const rows = [
    [M0 - 5 * US, 100],
    [M0 + 1 * US, 100.5],
    [M0 + 3600 * US + 5 * US, 90], // below the limit, but after the hour
    [M0 + DAY + 2 * US, 100],
  ];
  const [e] = events(await accumulate(from(rows), M0, M0), M0, M0);
  assert.equal(e.strict.buyFilled, false);
  assert.equal(e.touch.buyFilled, false);
});

test('a missing day is an error, not a silent skip', async () => {
  const rows = [
    [M0 + 1 * US, 100.5],
    [M0 + 3600 * US + 5 * US, 101],
  ];
  const days = await accumulate(from(rows), M0, M0);
  assert.throws(() => events(days, M0, M0), /missing data/);
});

test('bootstrap of a constant is that constant, and the seed is reproducible', () => {
  const flat = bootstrap(new Array(50).fill(7), 500, 1);
  assert.deepEqual([flat.mean, flat.lo, flat.hi], [7, 7, 7]);
  const x = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 10);
  assert.deepEqual(bootstrap(x, 500, 1), bootstrap(x, 500, 1));
  const r = rng(1);
  const first = [r(), r(), r()];
  const r2 = rng(1);
  assert.deepEqual(first, [r2(), r2(), r2()]);
});
