import type { Severity } from '@crypto-magic/notify';
import type { EventKind, StoredEvent } from '../persistence/repositories/event.repository';

/**
 * What each kind of event is worth waking someone for.
 *
 * Deliberately explicit per kind rather than derived from the event's log
 * level. The `error` kind covers transient exchange failures that repeat every
 * tick; mapping those to critical would let them bypass the hourly rate limit
 * and bury the one alert that matters. Only conditions that need a human
 * *now* are critical:
 *
 *   - the bot stopped itself and will not open new positions until you look
 *   - it does not agree with the exchange about what you own
 *
 * Returns null for kinds that are normal operation. A signal, a risk rejection
 * or a completed cycle is the bot working correctly; alerting on those trains
 * you to ignore the channel.
 */
export function severityForEvent(event: StoredEvent): Severity | null {
  switch (event.kind) {
    case 'kill_switch':
      // Engaging is critical; releasing is a human action already being watched.
      return event.level === 'error' ? 'critical' : 'info';

    case 'halt':
      return 'critical';

    case 'reconciliation':
      // Only a MISMATCH is critical; a clean reconcile is routine startup noise.
      return event.level === 'error' ? 'critical' : null;

    case 'order_rejected':
      return 'warning';

    case 'error':
      // Usually a transient exchange or network failure. Warning keeps it inside
      // the hourly budget so a retry loop cannot crowd out a real emergency.
      return 'warning';

    case 'position_opened':
    case 'position_closed':
    case 'engine_started':
    case 'engine_stopped':
      return 'info';

    default:
      return null;
  }
}

/** Short, scannable title. The body carries the detail. */
export function titleForEvent(event: StoredEvent): string {
  const titles: Partial<Record<EventKind, string>> = {
    kill_switch: event.level === 'error' ? 'Kill switch ENGAGED' : 'Kill switch released',
    halt: 'Trading halted',
    reconciliation: 'Reconciliation mismatch',
    order_rejected: 'Order rejected',
    error: 'Engine error',
    position_opened: 'Position opened',
    position_closed: 'Position closed',
    engine_started: 'Engine started',
    engine_stopped: 'Engine stopped',
  };
  return titles[event.kind] ?? event.kind.replace(/_/g, ' ');
}
