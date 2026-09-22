import { postWithTimeout, type Alert, type NotificationChannel, type Severity } from '../types';

/** ntfy priorities: 1 min … 5 max. 4+ bypasses a phone's quiet hours. */
const PRIORITY: Record<Severity, string> = { critical: '5', warning: '4', info: '3' };
const TAGS: Record<Severity, string> = {
  critical: 'rotating_light',
  warning: 'warning',
  info: 'information_source',
};

/**
 * ntfy push. The simplest channel to actually receive on a phone: install the
 * app, subscribe to a topic, done — no bot to register and no server to run.
 *
 * A topic on the public server is effectively a shared secret: anyone who knows
 * it can read your alerts. Use a long random one, and never put an API key or a
 * balance in an alert body.
 */
export class NtfyChannel implements NotificationChannel {
  readonly name = 'ntfy';

  constructor(
    private readonly topic: string,
    private readonly server = 'https://ntfy.sh',
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert): Promise<void> {
    const suffix =
      alert.suppressedSince && alert.suppressedSince > 0
        ? `\n(${alert.suppressedSince} identical suppressed since last)`
        : '';

    await postWithTimeout(
      this.name,
      `${this.server.replace(/\/$/, '')}/${this.topic}`,
      {
        method: 'POST',
        headers: {
          Title: alert.title.slice(0, 200),
          Priority: PRIORITY[alert.severity],
          Tags: TAGS[alert.severity],
        },
        body: `${alert.body}${suffix}`.slice(0, 4000),
      },
      this.timeoutMs,
      [this.topic],
    );
  }
}
