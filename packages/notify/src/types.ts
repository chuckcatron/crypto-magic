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

/** Shared fetch wrapper: bounded, and never leaves a socket hanging. */
export async function postWithTimeout(
  channel: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      throw new NotificationError(channel, `HTTP ${response.status} ${body}`.trim());
    }
  } catch (error) {
    if (error instanceof NotificationError) throw error;
    if ((error as Error)?.name === 'AbortError') {
      throw new NotificationError(channel, `timed out after ${timeoutMs}ms`);
    }
    throw new NotificationError(channel, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
