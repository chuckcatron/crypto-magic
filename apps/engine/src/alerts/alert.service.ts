import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { D } from '@crypto-magic/core';
import {
  AlertPolicy,
  fingerprint,
  type Alert,
  type FanoutNotifier,
  type Severity,
} from '@crypto-magic/notify';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EventRepository, type StoredEvent } from '../persistence/repositories/event.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { childLogger } from '../common/logger';
import { ALERT_POLICY, NOTIFIER } from './tokens';
import { severityForEvent, titleForEvent } from './severity';

const HEARTBEAT_INTERVAL = 'alert-heartbeat';
const LAST_HEARTBEAT_KEY = 'alerts:last_heartbeat_day';
/** Bounded so a delivery outage cannot grow the queue without limit. */
const MAX_QUEUE = 50;

interface Delivery {
  readonly at: number;
  readonly severity: Severity;
  readonly title: string;
  readonly results: { channel: string; ok: boolean; error?: string }[];
}

/**
 * Turns engine events into push notifications.
 *
 * Subscribes to the event log rather than being called from each failure site,
 * so a new code path that logs an event is alertable for free.
 *
 * Three properties, in order of importance:
 *
 *   1. It cannot affect trading. The event listener only enqueues; delivery
 *      happens on a later tick of the event loop. A hung webhook cannot delay
 *      a stop check.
 *   2. It cannot cry wolf. Every alert passes the AlertPolicy first — see the
 *      comment there. An alerting channel you have muted is worse than none,
 *      because you believe you are covered.
 *   3. Silence is meaningful. The daily heartbeat exists so that a dead bot is
 *      detectable: alerts can only fire while the process is alive, so the only
 *      signal a crashed engine can send is the message that does NOT arrive.
 */
@Injectable()
export class AlertService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = childLogger('alerts');
  private readonly queue: Alert[] = [];
  private readonly recent: Delivery[] = [];
  private unsubscribe: (() => void) | null = null;
  private draining = false;
  private started = false;
  private sent = 0;
  private dropped = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(NOTIFIER) private readonly notifier: FanoutNotifier,
    @Inject(ALERT_POLICY) private readonly policy: AlertPolicy,
    private readonly events: EventRepository,
    private readonly positions: PositionRepository,
    private readonly trades: TradeRepository,
    private readonly state: StateRepository,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.notifier.isConfigured) {
      this.log.info('alerting disabled — no channels configured');
      return;
    }

    this.unsubscribe = this.events.subscribe((event) => this.onEvent(event));
    this.started = true;
    this.log.info({ channels: this.notifier.channelNames }, 'alerting enabled');

    if (this.config.HEARTBEAT_ENABLED) {
      const interval = setInterval(() => void this.maybeSendHeartbeat(), 5 * 60_000);
      this.scheduler.addInterval(HEARTBEAT_INTERVAL, interval);
    }
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.started && this.scheduler.doesExist('interval', HEARTBEAT_INTERVAL)) {
      this.scheduler.deleteInterval(HEARTBEAT_INTERVAL);
    }
  }

  get status() {
    return {
      enabled: this.notifier.isConfigured,
      channels: this.notifier.channelNames,
      minSeverity: this.config.ALERT_MIN_SEVERITY,
      sent: this.sent,
      dropped: this.dropped,
      queued: this.queue.length,
      suppressed: this.policy.pendingSuppressions,
      heartbeat: this.config.HEARTBEAT_ENABLED ? `${this.config.HEARTBEAT_UTC_HOUR}:00 UTC` : null,
      recent: this.recent.slice(-10),
    };
  }

  /**
   * Runs INSIDE the trading loop's call to append(). It must return instantly:
   * classify, enqueue, and let the drain happen on a later tick.
   */
  private onEvent(event: StoredEvent): void {
    const severity = severityForEvent(event);
    if (!severity) return;

    const decision = this.policy.decide(severity, fingerprint(event.kind, event.message));
    if (!decision.send) {
      this.dropped++;
      return;
    }

    this.enqueue({
      severity,
      title: titleForEvent(event),
      body: event.message,
      timestamp: event.ts,
      fingerprint: fingerprint(event.kind, event.message),
      ...(decision.suppressedSince > 0 ? { suppressedSince: decision.suppressedSince } : {}),
    });
  }

  private enqueue(alert: Alert): void {
    if (this.queue.length >= MAX_QUEUE) {
      // Drop the OLDEST. During an outage the newest alerts describe the
      // current state; a queue full of stale ones is worse than useless.
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(alert);
    // Deliberately not awaited: this is called from the trading loop.
    setImmediate(() => void this.drain());
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const alert = this.queue.shift()!;
        const results = await this.notifier.send(alert);

        this.sent++;
        this.recent.push({ at: Date.now(), severity: alert.severity, title: alert.title, results });
        if (this.recent.length > 50) this.recent.shift();

        const failed = results.filter((r) => !r.ok);
        if (failed.length === results.length) {
          this.log.error(
            { title: alert.title, errors: failed.map((f) => f.error) },
            'alert reached NO channel',
          );
        } else if (failed.length > 0) {
          this.log.warn({ title: alert.title, failed: failed.map((f) => f.channel) }, 'alert partially delivered');
        }
      }
    } catch (error) {
      this.log.error({ err: String(error) }, 'alert delivery failed');
    } finally {
      this.draining = false;
    }
  }

  /**
   * A daily "still here" message, once past the configured UTC hour.
   *
   * The day is recorded in the database, so a restart cannot send it twice and
   * a process that was down at the hour still sends it on the next tick after
   * coming back.
   */
  private async maybeSendHeartbeat(): Promise<void> {
    const now = new Date();
    if (now.getUTCHours() < this.config.HEARTBEAT_UTC_HOUR) return;

    const today = now.toISOString().slice(0, 10);
    if (this.state.get(LAST_HEARTBEAT_KEY) === today) return;
    this.state.set(LAST_HEARTBEAT_KEY, today);

    await this.sendDirect({
      severity: 'info',
      title: `Daily check-in — ${this.config.TRADING_MODE}`,
      body: this.summary(),
      timestamp: Date.now(),
      fingerprint: `heartbeat:${today}`,
    });
  }

  private summary(): string {
    const open = this.positions.findAll();
    const dayStart = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    const closedToday = this.trades.recent(50).filter((t) => t.exitTime >= dayStart - 86_400_000);
    const pnl = closedToday.reduce((sum, t) => sum.plus(t.pnl), D(0));
    const equity = this.state.equityCurve(1)[0]?.equity;

    return [
      `Equity: ${equity ? `$${equity.toFixed(2)}` : 'unknown'}`,
      `Open positions: ${open.length}${open.length > 0 ? ` (${open.map((p) => p.productId).join(', ')})` : ''}`,
      `Closed in the last 24h: ${closedToday.length}, P&L ${pnl.gte(0) ? '+' : '-'}$${pnl.abs().toFixed(2)}`,
      '',
      'If you stop receiving this message, the bot is not running.',
    ].join('\n');
  }

  /** Bypasses the policy. Used by the heartbeat and the test button. */
  async sendDirect(alert: Alert): Promise<Delivery> {
    const results = await this.notifier.send(alert);
    this.sent++;
    const delivery = { at: Date.now(), severity: alert.severity, title: alert.title, results };
    this.recent.push(delivery);
    if (this.recent.length > 50) this.recent.shift();
    return delivery;
  }

  /**
   * Prove the channels work.
   *
   * An alerting setup you have never seen fire is not an alerting setup. This
   * deliberately skips the policy so it always sends.
   */
  async sendTestAlert(): Promise<Delivery> {
    return this.sendDirect({
      severity: 'warning',
      title: 'Test alert',
      body:
        `crypto-magic is reachable and alerting works.\n` +
        `Mode: ${this.config.TRADING_MODE}. Channels: ${this.notifier.channelNames.join(', ')}.\n` +
        'If you can read this, a real alert will reach you too.',
      timestamp: Date.now(),
      fingerprint: `test:${Date.now()}`,
    });
  }
}
