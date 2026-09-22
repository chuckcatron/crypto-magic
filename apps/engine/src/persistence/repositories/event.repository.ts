import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../tokens';
import type { Db } from '../database';
import type { EventStore } from '../ports';

export type EventLevel = 'info' | 'warn' | 'error';

export type EventKind =
  | 'engine_started'
  | 'engine_stopped'
  | 'cycle_completed'
  | 'signal'
  | 'order_submitted'
  | 'order_filled'
  | 'order_rejected'
  | 'position_opened'
  | 'position_closed'
  | 'risk_rejected'
  | 'halt'
  | 'kill_switch'
  | 'reconciliation'
  | 'trade_analysed'
  | 'error';

export interface StoredEvent {
  id?: number;
  ts: number;
  level: EventLevel;
  kind: EventKind;
  message: string;
  data?: unknown;
}

export type EventListener = (event: StoredEvent) => void;

@Injectable()
export class EventRepository implements EventStore {
  private readonly listeners = new Set<EventListener>();

  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /**
   * Observe every event as it is written. Returns an unsubscribe function.
   *
   * Alerting hangs off this rather than off individual call sites, so a new
   * failure path that logs an event is alertable without anyone remembering to
   * wire it up.
   *
   * Listeners run SYNCHRONOUSLY inside append(), which is called from the
   * trading loop. A listener must return immediately — queue the work, do not
   * do it here — and it must not throw.
   */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(event: Omit<StoredEvent, 'id' | 'ts'> & { ts?: number }): void {
    this.db
      .prepare('INSERT INTO events (ts, level, kind, message, data) VALUES (?, ?, ?, ?, ?)')
      .run(
        event.ts ?? Date.now(),
        event.level,
        event.kind,
        event.message,
        event.data === undefined ? null : safeStringify(event.data),
      );

    if (this.listeners.size === 0) return;
    const record: StoredEvent = { ...event, ts: event.ts ?? Date.now() };
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch {
        // A broken observer must never break the write that triggered it, and
        // certainly never the trade that triggered that.
      }
    }
  }

  recent(limit = 200): StoredEvent[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?')
      .all(limit)
      .map((row) => {
        const r = row as { id: number; ts: number; level: string; kind: string; message: string; data: string | null };
        return {
          id: r.id,
          ts: r.ts,
          level: r.level as EventLevel,
          kind: r.kind as EventKind,
          message: r.message,
          data: r.data ? safeParse(r.data) : undefined,
        };
      });
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: String(value) });
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}
