import { SEVERITY_RANK, type Severity } from './types';

export interface AlertPolicyConfig {
  /** Alerts weaker than this are dropped. */
  readonly minSeverity: Severity;
  /** The same fingerprint will not be re-sent within this window. */
  readonly cooldownSeconds: number;
  /** Ceiling on non-critical alerts per hour. */
  readonly maxPerHour: number;
}

export const DEFAULT_ALERT_POLICY: AlertPolicyConfig = {
  minSeverity: 'warning',
  cooldownSeconds: 900,
  maxPerHour: 12,
};

export type PolicyDecision =
  | { readonly send: true; readonly suppressedSince: number }
  | { readonly send: false; readonly reason: 'below_min_severity' | 'cooldown' | 'rate_limited' };

/**
 * Decides what is worth interrupting you for.
 *
 * This is the whole difference between an alerting channel you trust and one
 * you mute. The engine retries a failing exchange call every 30 seconds; left
 * unfiltered that is 120 identical pages an hour, you silence the channel, and
 * then you miss the kill switch at 3am. The failure mode of alerting is almost
 * never "too few alerts".
 *
 * Three rules:
 *   1. Below the minimum severity, drop it.
 *   2. The same fingerprint is sent at most once per cooldown. Occurrences in
 *      between are counted, not lost, and reported on the next delivery.
 *   3. An hourly ceiling bounds the rest — but CRITICAL alerts bypass it. A
 *      rate limit that can swallow "kill switch engaged" is a bug, not a
 *      feature. Critical still respects its own cooldown, so a stuck critical
 *      condition cannot become a flood either.
 */
export class AlertPolicy {
  private readonly lastSentAt = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  private recentSends: number[] = [];

  constructor(private readonly config: AlertPolicyConfig = DEFAULT_ALERT_POLICY) {}

  decide(severity: Severity, fingerprint: string, now: number = Date.now()): PolicyDecision {
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[this.config.minSeverity]) {
      return { send: false, reason: 'below_min_severity' };
    }

    const last = this.lastSentAt.get(fingerprint);
    if (last !== undefined && now - last < this.config.cooldownSeconds * 1000) {
      this.suppressed.set(fingerprint, (this.suppressed.get(fingerprint) ?? 0) + 1);
      return { send: false, reason: 'cooldown' };
    }

    this.recentSends = this.recentSends.filter((ts) => now - ts < 3_600_000);
    if (severity !== 'critical' && this.recentSends.length >= this.config.maxPerHour) {
      this.suppressed.set(fingerprint, (this.suppressed.get(fingerprint) ?? 0) + 1);
      return { send: false, reason: 'rate_limited' };
    }

    const suppressedSince = this.suppressed.get(fingerprint) ?? 0;
    this.suppressed.delete(fingerprint);
    this.lastSentAt.set(fingerprint, now);
    this.recentSends.push(now);

    return { send: true, suppressedSince };
  }

  /** Counts of what is currently being held back, for the dashboard. */
  get pendingSuppressions(): Record<string, number> {
    return Object.fromEntries(this.suppressed);
  }
}

/**
 * Collapse an event into a stable identity.
 *
 * Digit runs are replaced, so "price 61240.55 below stop" and "price 59180.20
 * below stop" are recognised as the same recurring condition rather than an
 * endless stream of unique alerts.
 */
export function fingerprint(kind: string, message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/[0-9]+(\.[0-9]+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${kind}:${normalized}`;
}
