import {
  AlertPolicy,
  DiscordChannel,
  FanoutNotifier,
  NtfyChannel,
  TelegramChannel,
  fingerprint,
  type NotificationChannel,
  type Severity,
} from '@crypto-magic/notify';
import { childLogger } from '../common/logger';
import type { FuturesConfig } from '../config/config';

/** Something that can be told about a paper event. A fake in tests. */
export interface Alerter {
  alert(severity: Severity, kind: string, title: string, body: string): void;
}

export const ALERTER = Symbol('ALERTER');

/**
 * Paper alerts through the same channels as the regime engine, filtered by the
 * same policy (cooldown, hourly cap). Every title says PAPER, so a paper fill
 * can never be mistaken for a real one on your phone. Delivery is
 * fire-and-forget: a hung webhook cannot stall the trading loop.
 */
export class NotifyAlerter implements Alerter {
  private readonly log = childLogger('alerts');

  constructor(
    private readonly notifier: FanoutNotifier,
    private readonly policy: AlertPolicy,
  ) {}

  static fromConfig(config: FuturesConfig): NotifyAlerter {
    const channels: NotificationChannel[] = [];
    if (config.DISCORD_WEBHOOK_URL) channels.push(new DiscordChannel(config.DISCORD_WEBHOOK_URL));
    if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
      channels.push(new TelegramChannel(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID));
    }
    if (config.NTFY_TOPIC) channels.push(new NtfyChannel(config.NTFY_TOPIC, config.NTFY_SERVER));
    return new NotifyAlerter(
      new FanoutNotifier(channels),
      new AlertPolicy({
        minSeverity: config.FUTURES_ALERT_MIN_SEVERITY,
        cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
        maxPerHour: config.ALERT_MAX_PER_HOUR,
      }),
    );
  }

  alert(severity: Severity, kind: string, title: string, body: string): void {
    if (!this.notifier.isConfigured) return;
    const key = fingerprint(`futures:${kind}`, title);
    const decision = this.policy.decide(severity, key);
    if (!decision.send) return;
    void this.notifier
      .send({
        severity,
        title: `PAPER futures: ${title}`,
        body,
        timestamp: Date.now(),
        fingerprint: key,
        suppressedSince: decision.suppressedSince,
      })
      .then((results) => {
        for (const r of results) {
          if (!r.ok) this.log.warn({ channel: r.channel, err: r.error }, 'alert delivery failed');
        }
      });
  }
}
