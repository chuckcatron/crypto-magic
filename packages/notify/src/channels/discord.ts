import { postWithTimeout, type Alert, type NotificationChannel, type Severity } from '../types';

/** Discord wants a DECIMAL integer here; a hex string is silently ignored. */
const COLORS: Record<Severity, number> = {
  critical: Number.parseInt('d03b3b', 16),
  warning: Number.parseInt('fab219', 16),
  info: Number.parseInt('2a78d6', 16),
};

const PREFIX: Record<Severity, string> = { critical: '🔴', warning: '🟡', info: '🔵' };

export class DiscordChannel implements NotificationChannel {
  readonly name = 'discord';

  constructor(
    private readonly webhookUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(alert: Alert): Promise<void> {
    const suffix =
      alert.suppressedSince && alert.suppressedSince > 0
        ? `\n\n_(${alert.suppressedSince} identical alert${alert.suppressedSince === 1 ? '' : 's'} suppressed since the last one)_`
        : '';

    await postWithTimeout(
      this.name,
      this.webhookUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          embeds: [
            {
              title: `${PREFIX[alert.severity]} ${alert.title}`.slice(0, 256),
              description: `${alert.body}${suffix}`.slice(0, 4000),
              color: COLORS[alert.severity],
              timestamp: new Date(alert.timestamp).toISOString(),
              footer: { text: 'crypto-magic' },
            },
          ],
          // Never ping. An error body containing "@everyone" would otherwise
          // notify a whole server; alerts are for you, not your channel.
          allowed_mentions: { parse: [] },
        }),
      },
      this.timeoutMs,
      [this.webhookUrl],
    );
  }
}
