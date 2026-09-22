import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../tokens';
import type { Db } from '../database';

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
  | 'error';

export interface StoredEvent {
  id?: number;
  ts: number;
  level: EventLevel;
  kind: EventKind;
  message: string;
  data?: unknown;
}

@Injectable()
export class EventRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

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
