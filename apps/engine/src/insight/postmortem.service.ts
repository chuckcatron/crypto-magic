import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  buildPostMortemPrompt,
  parsePostMortemResponse,
  type LlmClient,
  type NewsItem,
  type NewsProvider,
  type PostMortemInput,
} from '@crypto-magic/insight';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EventRepository } from '../persistence/repositories/event.repository';
import { TradeAnalysisRepository } from '../persistence/repositories/trade-analysis.repository';
import { TradeRepository, type StoredTrade } from '../persistence/repositories/trade.repository';
import { childLogger } from '../common/logger';
import { LLM_CLIENT, NEWS_PROVIDER } from './tokens';

const INTERVAL_NAME = 'postmortem-worker';
/** Trades analysed per pass. One at a time, since the model is a shared resource. */
const BATCH_SIZE = 3;

/**
 * Writes an analysis of each closed trade using the local model.
 *
 * Three properties matter more than anything this produces:
 *
 *   1. It runs entirely OUTSIDE the trade path. It is a separate timer, reading
 *      already-closed trades. Nothing here can delay a tick, a stop check or an
 *      order — a local model can take a minute to answer, which is an eternity
 *      to a position with a stop to honour.
 *   2. Every failure is swallowed. No model, a wedged model, unparseable output,
 *      news that will not load: all of them cost a post-mortem and nothing else.
 *   3. It is driven by a query, not an event. The worker looks for closed trades
 *      that lack an analysis, so a crash mid-generation loses nothing and a
 *      restart simply picks the trade up again.
 */
@Injectable()
export class PostMortemService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = childLogger('postmortem');
  private running = false;
  private started = false;
  private lastError: string | null = null;
  private analysedCount = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient | null,
    @Inject(NEWS_PROVIDER) private readonly news: NewsProvider,
    private readonly trades: TradeRepository,
    private readonly analyses: TradeAnalysisRepository,
    private readonly events: EventRepository,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.llm || !this.config.POSTMORTEM_ENABLED) {
      this.log.info('trade post-mortems disabled');
      return;
    }
    const interval = setInterval(
      () => void this.runOnce(),
      this.config.POSTMORTEM_INTERVAL_SECONDS * 1000,
    );
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.started = true;
    this.log.info(
      { model: this.llm.model, everySeconds: this.config.POSTMORTEM_INTERVAL_SECONDS },
      'post-mortem worker started',
    );
  }

  onModuleDestroy(): void {
    if (this.started && this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  get status() {
    return {
      enabled: Boolean(this.llm) && this.config.POSTMORTEM_ENABLED,
      model: this.llm?.model ?? null,
      newsProvider: this.news.isConfigured ? this.news.name : null,
      pending: this.analyses.countPending(),
      analysed: this.analysedCount,
      lastError: this.lastError,
    };
  }

  /** One pass. Safe to call directly; overlapping passes are skipped. */
  async runOnce(): Promise<number> {
    if (!this.llm || this.running) return 0;

    const pending = this.analyses.pendingTradeIds(BATCH_SIZE);
    if (pending.length === 0) return 0;

    // Probing first avoids burning the whole batch against a stopped Ollama
    // waiting for each call to time out.
    if (!(await this.llm.isAvailable())) {
      this.lastError = `${this.llm.model} is not available from ${this.llm.name}`;
      this.log.warn({ model: this.llm.model }, 'skipping post-mortems: model unavailable');
      return 0;
    }

    this.running = true;
    let done = 0;
    try {
      for (const tradeId of pending) {
        if (await this.analyseTrade(tradeId)) done++;
      }
    } finally {
      this.running = false;
    }
    return done;
  }

  private async analyseTrade(tradeId: number): Promise<boolean> {
    const trade = this.trades.findById(tradeId);
    if (!trade) return false;

    try {
      const news = await this.fetchNews(trade);
      const prompt = buildPostMortemPrompt(toInput(trade, news));

      const response = await this.llm!.complete({
        system: prompt.system,
        user: prompt.user,
        json: true,
        maxTokens: this.config.LLM_MAX_TOKENS,
        timeoutMs: this.config.LLM_TIMEOUT_MS,
      });

      const analysis = parsePostMortemResponse(response.text);
      if (!analysis) {
        // Not an exception: small models fail to produce clean JSON sometimes.
        // Record the attempt so we retry a couple of times and then move on.
        this.analyses.recordFailure(tradeId, `unparseable response: ${response.text.slice(0, 200)}`);
        this.log.warn({ tradeId, model: response.model }, 'model returned unparseable analysis');
        return false;
      }

      this.analyses.save({
        ...analysis,
        tradeId,
        createdAt: Date.now(),
        model: response.model,
        newsCount: news.length,
        durationMs: response.durationMs,
      });
      this.analysedCount++;
      this.lastError = null;

      this.log.info(
        { tradeId, verdict: analysis.verdict, tookMs: response.durationMs, headlines: news.length },
        'trade analysed',
      );
      this.events.append({
        level: 'info',
        kind: 'trade_analysed',
        message: `${trade.productId} #${tradeId}: ${analysis.verdict.replace(/_/g, ' ')} — ${analysis.summary}`,
        data: { tradeId, verdict: analysis.verdict },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.analyses.recordFailure(tradeId, message);
      this.log.error({ tradeId, err: message }, 'post-mortem failed');
      return false;
    }
  }

  /**
   * Headlines from the trade's own window, plus a lead-in before entry so a
   * catalyst that caused the move is visible rather than just its aftermath.
   */
  private async fetchNews(trade: StoredTrade): Promise<NewsItem[]> {
    if (!this.news.isConfigured) return [];
    const base = trade.productId.split('-')[0];
    if (!base) return [];

    try {
      return await this.news.headlines({
        symbols: [base],
        since: trade.entryTime - this.config.NEWS_LEAD_IN_HOURS * 3_600_000,
        until: trade.exitTime,
        limit: 10,
      });
    } catch {
      // Already defensive inside the client; belt and braces because a missing
      // headline must never cost us the analysis.
      return [];
    }
  }
}

function toInput(trade: StoredTrade, news: NewsItem[]): PostMortemInput {
  return {
    productId: trade.productId,
    entryTime: trade.entryTime,
    exitTime: trade.exitTime,
    entryPrice: trade.entryPrice.toFixed(),
    exitPrice: trade.exitPrice.toFixed(),
    baseSize: trade.baseSize.toFixed(),
    fees: trade.fees.toFixed(),
    pnl: trade.pnl.toFixed(),
    pnlPct: trade.pnlPct,
    exitReason: trade.exitReason,
    entryReasons: trade.entryReasons,
    confidence: trade.confidence,
    stopPrice: trade.stopPrice?.toFixed() ?? null,
    takeProfitPrice: trade.takeProfitPrice?.toFixed() ?? null,
    news,
  };
}
