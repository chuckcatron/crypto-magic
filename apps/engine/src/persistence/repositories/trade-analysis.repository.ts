import { Inject, Injectable } from '@nestjs/common';
import type { PostMortemAnalysis, Verdict } from '@crypto-magic/insight';
import { DATABASE } from '../tokens';
import type { Db } from '../database';
import type { TradeAnalysisStore } from '../ports';

export interface StoredTradeAnalysis extends PostMortemAnalysis {
  readonly tradeId: number;
  readonly createdAt: number;
  readonly model: string;
  readonly newsCount: number;
  readonly durationMs: number;
}

/** Give up on a trade after this many failed attempts. */
export const MAX_ANALYSIS_ATTEMPTS = 3;

@Injectable()
export class TradeAnalysisRepository implements TradeAnalysisStore {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  find(tradeId: number): StoredTradeAnalysis | null {
    const row = this.db.prepare('SELECT * FROM trade_analyses WHERE trade_id = ?').get(tradeId);
    return row ? toAnalysis(row as never) : null;
  }

  findMany(tradeIds: number[]): Map<number, StoredTradeAnalysis> {
    if (tradeIds.length === 0) return new Map();
    const placeholders = tradeIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM trade_analyses WHERE trade_id IN (${placeholders})`)
      .all(...tradeIds);
    return new Map(rows.map((row) => {
      const analysis = toAnalysis(row as never);
      return [analysis.tradeId, analysis];
    }));
  }

  save(analysis: StoredTradeAnalysis): void {
    this.db
      .prepare(
        `INSERT INTO trade_analyses (
           trade_id, created_at, model, verdict, summary, what_worked, what_didnt,
           lesson, used_news, news_count, duration_ms
         ) VALUES (
           @tradeId, @createdAt, @model, @verdict, @summary, @whatWorked, @whatDidnt,
           @lesson, @usedNews, @newsCount, @durationMs
         )
         ON CONFLICT(trade_id) DO UPDATE SET
           created_at = excluded.created_at,
           model = excluded.model,
           verdict = excluded.verdict,
           summary = excluded.summary,
           what_worked = excluded.what_worked,
           what_didnt = excluded.what_didnt,
           lesson = excluded.lesson,
           used_news = excluded.used_news,
           news_count = excluded.news_count,
           duration_ms = excluded.duration_ms`,
      )
      .run({
        tradeId: analysis.tradeId,
        createdAt: analysis.createdAt,
        model: analysis.model,
        verdict: analysis.verdict,
        summary: analysis.summary,
        whatWorked: JSON.stringify(analysis.whatWorked),
        whatDidnt: JSON.stringify(analysis.whatDidnt),
        lesson: analysis.lesson,
        usedNews: analysis.usedNews ? 1 : 0,
        newsCount: analysis.newsCount,
        durationMs: analysis.durationMs,
      });
    // A trade that finally succeeded should not keep its failure record.
    this.db.prepare('DELETE FROM trade_analysis_failures WHERE trade_id = ?').run(analysis.tradeId);
  }

  recordFailure(tradeId: number, error: string): void {
    this.db
      .prepare(
        `INSERT INTO trade_analysis_failures (trade_id, attempts, last_error, last_tried)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(trade_id) DO UPDATE SET
           attempts = attempts + 1,
           last_error = excluded.last_error,
           last_tried = excluded.last_tried`,
      )
      .run(tradeId, error.slice(0, 500), Date.now());
  }

  /**
   * Closed trades still awaiting an analysis, NEWEST first.
   *
   * Newest rather than oldest because the trade you want a review of is the one
   * that just closed and is at the top of the dashboard. Oldest-first makes a
   * first run with a backlog analyse everything you no longer care about before
   * reaching the one you do. In steady state there is only ever one pending, so
   * the order only matters when it matters most.
   *
   * Excludes trades that have already failed the maximum number of times. A
   * model that cannot produce parseable JSON for one awkward trade must not
   * block every trade behind it forever.
   */
  pendingTradeIds(limit: number): number[] {
    return this.db
      .prepare(
        `SELECT t.id FROM trades t
         LEFT JOIN trade_analyses a ON a.trade_id = t.id
         LEFT JOIN trade_analysis_failures f ON f.trade_id = t.id
         WHERE a.trade_id IS NULL AND COALESCE(f.attempts, 0) < ?
         ORDER BY t.exit_time DESC
         LIMIT ?`,
      )
      .all(MAX_ANALYSIS_ATTEMPTS, limit)
      .map((row) => (row as { id: number }).id);
  }

  countPending(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM trades t
         LEFT JOIN trade_analyses a ON a.trade_id = t.id
         LEFT JOIN trade_analysis_failures f ON f.trade_id = t.id
         WHERE a.trade_id IS NULL AND COALESCE(f.attempts, 0) < ?`,
      )
      .get(MAX_ANALYSIS_ATTEMPTS) as { n: number };
    return row.n;
  }
}

function toAnalysis(row: Record<string, string | number | null>): StoredTradeAnalysis {
  return {
    tradeId: Number(row.trade_id),
    createdAt: Number(row.created_at),
    model: String(row.model),
    verdict: String(row.verdict) as Verdict,
    summary: String(row.summary),
    whatWorked: parseArray(String(row.what_worked ?? '[]')),
    whatDidnt: parseArray(String(row.what_didnt ?? '[]')),
    lesson: row.lesson === null ? null : String(row.lesson),
    usedNews: Number(row.used_news) === 1,
    newsCount: Number(row.news_count ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
  };
}

function parseArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
