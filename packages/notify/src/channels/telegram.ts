import { postWithTimeout, type Alert, type NotificationChannel, type Severity } from '../types';

const PREFIX: Record<Severity, string> = { critical: '🔴', warning: '🟡', info: '🔵' };

export class TelegramChannel implements NotificationChannel {
  readonly name = 'telegram';

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly timeoutMs = 10_000,
    /** Overridable so the wire format can be asserted against a local server. */
    private readonly apiBase = 'https://api.telegram.org',
  ) {}

  async send(alert: Alert): Promise<void> {
    const suffix =
      alert.suppressedSince && alert.suppressedSince > 0
        ? `\n\n<i>${alert.suppressedSince} identical suppressed since last</i>`
        : '';

    await postWithTimeout(
      this.name,
      `${this.apiBase.replace(/\/$/, '')}/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: `${PREFIX[alert.severity]} <b>${escapeHtml(alert.title)}</b>\n${escapeHtml(alert.body)}${suffix}`.slice(
            0,
            4000,
          ),
          parse_mode: 'HTML',
          // Info is worth recording but not worth buzzing a pocket at 3am.
          disable_notification: alert.severity === 'info',
        }),
      },
      this.timeoutMs,
    );
  }
}

/** Telegram's HTML mode rejects a message containing stray angle brackets. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
