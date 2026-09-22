import { describe, expect, it } from 'vitest';
import { AlertPolicy, DEFAULT_ALERT_POLICY, fingerprint } from './policy';

const config = { ...DEFAULT_ALERT_POLICY, cooldownSeconds: 60, maxPerHour: 3 };
const T0 = 1_700_000_000_000;

describe('fingerprint', () => {
  it('treats the same condition with different numbers as one alert', () => {
    expect(fingerprint('error', 'price 61240.55 below stop')).toBe(
      fingerprint('error', 'price 59180.20 below stop'),
    );
  });

  it('keeps genuinely different messages apart', () => {
    expect(fingerprint('error', 'exchange unreachable')).not.toBe(
      fingerprint('error', 'order rejected'),
    );
  });

  it('separates the same text under different kinds', () => {
    expect(fingerprint('error', 'halted')).not.toBe(fingerprint('halt', 'halted'));
  });
});

describe('AlertPolicy severity threshold', () => {
  it('drops anything below the minimum', () => {
    const policy = new AlertPolicy({ ...config, minSeverity: 'warning' });
    expect(policy.decide('info', 'a', T0)).toEqual({ send: false, reason: 'below_min_severity' });
  });

  it('passes the minimum and above', () => {
    const policy = new AlertPolicy({ ...config, minSeverity: 'warning' });
    expect(policy.decide('warning', 'a', T0).send).toBe(true);
    expect(policy.decide('critical', 'b', T0).send).toBe(true);
  });

  it('can be opened up to info', () => {
    const policy = new AlertPolicy({ ...config, minSeverity: 'info' });
    expect(policy.decide('info', 'a', T0).send).toBe(true);
  });
});

describe('AlertPolicy cooldown', () => {
  it('sends the first occurrence and holds the rest', () => {
    const policy = new AlertPolicy(config);
    expect(policy.decide('warning', 'x', T0).send).toBe(true);
    expect(policy.decide('warning', 'x', T0 + 1000)).toEqual({ send: false, reason: 'cooldown' });
    expect(policy.decide('warning', 'x', T0 + 59_000)).toEqual({ send: false, reason: 'cooldown' });
  });

  it('sends again once the cooldown expires', () => {
    const policy = new AlertPolicy(config);
    policy.decide('warning', 'x', T0);
    expect(policy.decide('warning', 'x', T0 + 61_000).send).toBe(true);
  });

  it('reports how many were swallowed, so nothing is silently lost', () => {
    const policy = new AlertPolicy(config);
    policy.decide('warning', 'x', T0);
    for (let i = 1; i <= 5; i++) policy.decide('warning', 'x', T0 + i * 1000);

    const decision = policy.decide('warning', 'x', T0 + 61_000);
    expect(decision).toEqual({ send: true, suppressedSince: 5 });
  });

  it('resets the suppressed count after reporting it', () => {
    const policy = new AlertPolicy(config);
    policy.decide('warning', 'x', T0);
    policy.decide('warning', 'x', T0 + 1000);
    policy.decide('warning', 'x', T0 + 61_000);
    expect(policy.decide('warning', 'x', T0 + 122_000)).toEqual({ send: true, suppressedSince: 0 });
  });

  it('cools down each fingerprint independently', () => {
    const policy = new AlertPolicy(config);
    expect(policy.decide('warning', 'x', T0).send).toBe(true);
    expect(policy.decide('warning', 'y', T0).send).toBe(true);
  });
});

describe('AlertPolicy rate limiting', () => {
  it('caps non-critical alerts per hour', () => {
    const policy = new AlertPolicy(config); // maxPerHour 3
    expect(policy.decide('warning', 'a', T0).send).toBe(true);
    expect(policy.decide('warning', 'b', T0).send).toBe(true);
    expect(policy.decide('warning', 'c', T0).send).toBe(true);
    expect(policy.decide('warning', 'd', T0)).toEqual({ send: false, reason: 'rate_limited' });
  });

  it('NEVER rate-limits a critical alert', () => {
    const policy = new AlertPolicy(config);
    for (const key of ['a', 'b', 'c', 'd', 'e']) policy.decide('warning', key, T0);

    // A rate limit that can swallow "kill switch engaged" is a bug.
    expect(policy.decide('critical', 'kill-switch', T0).send).toBe(true);
    expect(policy.decide('critical', 'daily-loss', T0).send).toBe(true);
  });

  it('still cools down a repeated critical, so it cannot flood', () => {
    const policy = new AlertPolicy(config);
    expect(policy.decide('critical', 'k', T0).send).toBe(true);
    expect(policy.decide('critical', 'k', T0 + 1000)).toEqual({ send: false, reason: 'cooldown' });
  });

  it('lets the hourly budget roll off', () => {
    const policy = new AlertPolicy(config);
    for (const key of ['a', 'b', 'c']) policy.decide('warning', key, T0);
    expect(policy.decide('warning', 'd', T0).send).toBe(false);
    expect(policy.decide('warning', 'd', T0 + 3_600_001).send).toBe(true);
  });
});

describe('AlertPolicy realistic flood', () => {
  it('turns a failure repeating every 30s for an hour into a handful of alerts', () => {
    const policy = new AlertPolicy({ minSeverity: 'warning', cooldownSeconds: 900, maxPerHour: 12 });
    let sent = 0;
    // Exactly the Coinbase 403 loop observed in this session.
    for (let i = 0; i < 120; i++) {
      if (policy.decide('warning', 'error:exchange unreachable', T0 + i * 30_000).send) sent++;
    }
    expect(sent).toBe(4); // one per 15-minute cooldown
  });

  it('still delivers a critical arriving in the middle of that flood', () => {
    const policy = new AlertPolicy({ minSeverity: 'warning', cooldownSeconds: 900, maxPerHour: 12 });
    for (let i = 0; i < 60; i++) policy.decide('warning', 'error:noise', T0 + i * 30_000);
    expect(policy.decide('critical', 'kill_switch:engaged', T0 + 900_000).send).toBe(true);
  });
});
