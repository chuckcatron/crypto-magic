export type Severity = 'info' | 'warning' | 'critical';

/** Ordered weakest to strongest, for threshold comparisons. */
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export interface Alert {
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  readonly timestamp: number;
  /**
   * Stable key identifying "the same alert happening again". Two occurrences
   * sharing a fingerprint are collapsed by the cooldown.
   */
  readonly fingerprint: string;
  /** Identical alerts swallowed since this one last went out. */
  readonly suppressedSince?: number;
}

/**
 * Somewhere an alert can be delivered.
 *
 * Throws on failure — the caller decides whether that matters. Nothing on this
 * interface can touch trading; a channel is write-only and outbound.
 */
export interface NotificationChannel {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

export class NotificationError extends Error {
  constructor(
    readonly channel: string,
    message: string,
  ) {
    super(`${channel}: ${message}`);
    this.name = 'NotificationError';
  }
}

/**
 * Replace every occurrence of a secret in a string.
 *
 * A Telegram bot token lives in the request URL and a Discord webhook URL IS its
 * credential. Error text from these calls ends up in the log file and on the
 * /api/alerts endpoint, so it must never be able to carry one. Node's fetch does
 * not currently echo URLs in its errors — verified in the security review — but
 * that is an implementation detail of a dependency, not a guarantee.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Shared fetch wrapper: bounded, never leaves a socket hanging, never leaks a secret. */
export async function postWithTimeout(
  channel: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  secrets: readonly string[] = [],
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      throw new NotificationError(channel, scrub(`HTTP ${response.status} ${body}`.trim(), secrets));
    }
  } catch (error) {
    if (error instanceof NotificationError) throw error;
    if ((error as Error)?.name === 'AbortError') {
      throw new NotificationError(channel, `timed out after ${timeoutMs}ms`);
    }
    throw new NotificationError(
      channel,
      scrub(error instanceof Error ? error.message : String(error), secrets),
    );
  } finally {
    clearTimeout(timer);
  }
}
