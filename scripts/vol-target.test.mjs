// Run with: node --test scripts/vol-target.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sigmaBefore, volTarget, summarize } from './vol-target.mjs';

const DAY = 86_400;
const T0 = 1_600_000_000 - (1_600_000_000 % DAY);

/** Closes that alternate up and down by `pct` each day, starting from 100. */
function alternating(n, pct) {
  const closes = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    if (i > 0) price *= i % 2 === 1 ? 1 + pct : 1 / (1 + pct);
    closes.push({ time: T0 + i * DAY, close: price });
  }
  return closes;
}

/** A baseline curve that is flat, then held (gaining `step` per bar), then flat again. */
function baselineCurve(start, heldBars, step, flatAfter = 2) {
  const curve = [{ time: start, equity: 1000, positionValue: 0 }];
  let eq = 1000;
  for (let i = 1; i <= heldBars; i++) {
    eq *= 1 + step;
    curve.push({ time: start + i * DAY, equity: eq, positionValue: eq });
  }
  for (let i = 1; i <= flatAfter; i++) {
    curve.push({ time: start + (heldBars + i) * DAY, equity: eq, positionValue: 0 });
  }
  return curve;
}

test('sigma matches a hand calculation for alternating returns', () => {
  const closes = alternating(60, 0.01);
  const sigma = sigmaBefore(closes, T0 + 50 * DAY, 30);
  // Returns alternate +ln(1.01) and -ln(1.01): mean 0, sample sd = ln(1.01) * sqrt(30/29).
  const expected = Math.log(1.01) * Math.sqrt(30 / 29) * Math.sqrt(365);
  assert.ok(Math.abs(sigma - expected) < 1e-9, `${sigma} vs ${expected}`);
});

test('sigma ignores closes at or after the cutoff (no lookahead)', () => {
  const closes = alternating(60, 0.01);
  const before = sigmaBefore(closes, T0 + 50 * DAY, 30);
  const changed = closes.map((c, i) => (i >= 50 ? { ...c, close: c.close * 5 } : c));
  assert.equal(sigmaBefore(changed, T0 + 50 * DAY, 30), before);
});

test('weight is target over sigma, capped at 1, and scales the baseline return', () => {
  // Quiet market: sigma is small, so the weight is capped at 1 and equals the baseline.
  const quiet = alternating(80, 0.001);
  const base = {
    initialEquity: 1000,
    strategy: 's',
    productId: 'X',
    equityCurve: baselineCurve(T0 + 40 * DAY, 5, 0.02),
  };
  const full = volTarget(base, quiet);
  assert.ok(Math.abs(full.finalEquity - base.equityCurve.at(-1).equity) < 1e-9);

  // Wild market: sigma = ln(1.05)*sqrt(30/29)*sqrt(365); weight = 0.5 / sigma.
  const wild = alternating(80, 0.05);
  const sigma = Math.log(1.05) * Math.sqrt(30 / 29) * Math.sqrt(365);
  const w = 0.5 / sigma;
  assert.ok(w < 1);
  const result = volTarget(base, wild, { band: 10 }); // band so large nothing resizes
  const expected = 1000 * (1 + w * 0.02) ** 5;
  assert.ok(Math.abs(result.finalEquity - expected) < 1e-6, `${result.finalEquity} vs ${expected}`);
  assert.equal(result.context.resizes, 0);
});

test('a flat baseline stays flat', () => {
  const base = {
    initialEquity: 1000,
    strategy: 's',
    productId: 'X',
    equityCurve: baselineCurve(T0 + 40 * DAY, 0, 0, 5),
  };
  const result = volTarget(base, alternating(80, 0.05));
  assert.equal(result.finalEquity, 1000);
});

test('resizes only when the weight moves by more than the band, and pays for it', () => {
  // Calm for 45 bars, then wild: sigma jumps, so the target weight drops from 1 to well below.
  const closes = [];
  let price = 100;
  for (let i = 0; i < 100; i++) {
    const pct = i < 45 ? 0.001 : 0.05;
    if (i > 0) price *= i % 2 === 1 ? 1 + pct : 1 / (1 + pct);
    closes.push({ time: T0 + i * DAY, close: price });
  }
  const base = {
    initialEquity: 1000,
    strategy: 's',
    productId: 'X',
    equityCurve: baselineCurve(T0 + 40 * DAY, 40, 0),
  };
  const tight = volTarget(base, closes, { band: 0.1 });
  assert.ok(tight.context.resizes >= 1);
  assert.ok(tight.context.resizeFees > 0);
  assert.ok(tight.finalEquity < 1000, 'a zero-return baseline can only lose resize fees');

  const never = volTarget(base, closes, { band: 10 });
  assert.equal(never.context.resizes, 0);
  assert.equal(never.finalEquity, 1000);
});

test('resize fee is resizeBps of the notional traded', () => {
  // One resize from weight 1 to w with a zero-return baseline: fee = |1 - w| * equity * 65bps.
  const closes = [];
  let price = 100;
  for (let i = 0; i < 100; i++) {
    const pct = i < 41 ? 0.001 : 0.05;
    if (i > 0) price *= i % 2 === 1 ? 1 + pct : 1 / (1 + pct);
    closes.push({ time: T0 + i * DAY, close: price });
  }
  const base = {
    initialEquity: 1000,
    strategy: 's',
    productId: 'X',
    equityCurve: baselineCurve(T0 + 40 * DAY, 40, 0),
  };
  const result = volTarget(base, closes, { band: 0.1 });
  assert.ok(result.context.resizes >= 1);
  const first = result.weights.find((p) => p.weight > 0);
  assert.equal(first.weight, 1);
  const expectedMax = 1000 * 0.0065 * result.context.resizes;
  assert.ok(result.context.resizeFees <= expectedMax + 1e-9);
});

test('summarize matches a simple doubling over one year', () => {
  const curve = [
    { time: 0, equity: 100 },
    { time: 365 * DAY, equity: 200 },
  ];
  const m = summarize(100, curve);
  assert.ok(Math.abs(m.annualizedReturnPct - 100) < 1e-9);
  assert.equal(m.maxDrawdownPct, 0);
});
