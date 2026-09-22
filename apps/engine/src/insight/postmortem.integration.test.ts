import { Test, type TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { D } from '@crypto-magic/core';
import type { LlmClient, LlmRequest, LlmResponse, NewsItem, NewsProvider } from '@crypto-magic/insight';
import { APP_CONFIG } from '../config/tokens';
import { loadConfig, type AppConfig } from '../config/config.schema';
import { openDatabase } from '../persistence/database';
import { DATABASE } from '../persistence/tokens';
import { EventRepository } from '../persistence/repositories/event.repository';
import {
  MAX_ANALYSIS_ATTEMPTS,
  TradeAnalysisRepository,
} from '../persistence/repositories/trade-analysis.repository';
import { TradeRepository, type StoredTrade } from '../persistence/repositories/trade.repository';
import { LLM_CLIENT, NEWS_PROVIDER } from './tokens';
import { PostMortemService } from './postmortem.service';

const GOOD_REPLY = JSON.stringify({
  verdict: 'sound_process_lost',
  summary: 'The bot followed its rules and the stop did its job.',
  whatWorked: ['stop capped the loss at one risk unit'],
  whatDidnt: ['entry was late in the move'],
  lesson: 'A stopped-out trend entry is a cost of doing business.',
  usedNews: false,
});

class FakeLlm implements LlmClient {
  readonly name = 'fake';
  readonly model = 'fake-model';
  available = true;
  reply: string = GOOD_REPLY;
  throws: Error | null = null;
  calls: LlmRequest[] = [];

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    if (this.throws) throw this.throws;
    return { text: this.reply, model: this.model, durationMs: 42 };
  }
}

class FakeNews implements NewsProvider {
  readonly name = 'fake-news';
  isConfigured = true;
  items: NewsItem[] = [];
  throws = false;
  async headlines(): Promise<NewsItem[]> {
    if (this.throws) throw new Error('news is down');
    return this.items;
  }
}

const trade = (overrides: Partial<StoredTrade> = {}): StoredTrade => ({
  productId: 'BTC-USD',
  entryTime: Date.parse('2026-09-01T12:00:00Z'),
  exitTime: Date.parse('2026-09-01T20:00:00Z'),
  entryPrice: D('61240.55'),
  exitPrice: D('59180.20'),
  baseSize: D('0.00038'),
  fees: D('0.28'),
  pnl: D('-1.06'),
  pnlPct: -3.36,
  exitReason: 'stop_loss',
  entryReasons: ['EMA12 crossed above EMA26'],
  confidence: 0.61,
  mode: 'paper',
  stopPrice: D('59180.20'),
  takeProfitPrice: D('65360.90'),
  ...overrides,
});

describe('PostMortemService', () => {
  let moduleRef: TestingModule;
  let service: PostMortemService;
  let llm: FakeLlm;
  let news: FakeNews;
  let trades: TradeRepository;
  let analyses: TradeAnalysisRepository;
  let events: EventRepository;

  const build = async (overrides: Record<string, string> = {}) => {
    const config: AppConfig = loadConfig({
      TRADING_MODE: 'paper',
      DATABASE_PATH: ':memory:',
      LLM_ENABLED: 'true',
      POSTMORTEM_ENABLED: 'true',
      LOG_LEVEL: 'fatal',
      ...overrides,
    } as NodeJS.ProcessEnv);

    llm = new FakeLlm();
    news = new FakeNews();

    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DATABASE, useFactory: () => openDatabase(':memory:') },
        { provide: LLM_CLIENT, useValue: llm },
        { provide: NEWS_PROVIDER, useValue: news },
        TradeRepository,
        TradeAnalysisRepository,
        EventRepository,
        PostMortemService,
      ],
    }).compile();

    service = moduleRef.get(PostMortemService);
    trades = moduleRef.get(TradeRepository);
    analyses = moduleRef.get(TradeAnalysisRepository);
    events = moduleRef.get(EventRepository);
  };

  beforeEach(() => build());
  afterEach(async () => moduleRef?.close());

  it('analyses a closed trade and stores the verdict', async () => {
    trades.insert(trade());

    expect(await service.runOnce()).toBe(1);

    const stored = analyses.find(1);
    expect(stored?.verdict).toBe('sound_process_lost');
    expect(stored?.summary).toContain('followed its rules');
    expect(stored?.model).toBe('fake-model');
  });

  it('gives the model the real numbers and the entry reasons', async () => {
    trades.insert(trade());
    await service.runOnce();

    const prompt = llm.calls[0]!.user;
    expect(prompt).toContain('BTC-USD');
    expect(prompt).toContain('61240.55');
    expect(prompt).toContain('stop_loss');
    expect(prompt).toContain('EMA12 crossed above EMA26');
  });

  it('does not analyse the same trade twice', async () => {
    trades.insert(trade());
    await service.runOnce();
    await service.runOnce();
    expect(llm.calls).toHaveLength(1);
  });

  it('analyses the most recent trade first, since that is the one on screen', async () => {
    const base = Date.parse('2026-09-01T00:00:00Z');
    // Insert oldest-to-newest, so row ids ascend with time.
    for (let i = 0; i < 4; i++) trades.insert(trade({ exitTime: base + i * 3_600_000 }));

    // Batch size is 3, so the oldest of the four must be the one left over.
    await service.runOnce();

    expect(analyses.find(4)).not.toBeNull();
    expect(analyses.find(1)).toBeNull();
    expect(analyses.countPending()).toBe(1);
  });

  it('works through a whole backlog across passes', async () => {
    const base = Date.parse('2026-09-01T00:00:00Z');
    for (let i = 0; i < 5; i++) trades.insert(trade({ exitTime: base + i * 3_600_000 }));

    await service.runOnce();
    await service.runOnce();

    expect(analyses.countPending()).toBe(0);
  });

  it('attaches headlines from the trade window when news is configured', async () => {
    news.items = [
      {
        id: '1',
        title: 'Exchange halts withdrawals',
        url: 'https://example.com/a',
        source: 'Wire',
        publishedAt: Date.parse('2026-09-01T16:00:00Z'),
      },
    ];
    trades.insert(trade());
    await service.runOnce();

    expect(llm.calls[0]!.user).toContain('Exchange halts withdrawals');
    expect(analyses.find(1)?.newsCount).toBe(1);
  });

  it('still produces an analysis when the news provider is down', async () => {
    news.throws = true;
    trades.insert(trade());

    expect(await service.runOnce()).toBe(1);
    expect(analyses.find(1)).not.toBeNull();
  });

  describe('failure handling', () => {
    it('does nothing when the model is unavailable, without burning attempts', async () => {
      llm.available = false;
      trades.insert(trade());

      expect(await service.runOnce()).toBe(0);
      expect(llm.calls).toHaveLength(0);
      // Still pending: an offline Ollama must not consume the retry budget.
      expect(analyses.countPending()).toBe(1);
    });

    it('records a failure when the model returns unparseable output', async () => {
      llm.reply = 'I think that trade was fine, honestly.';
      trades.insert(trade());

      expect(await service.runOnce()).toBe(0);
      expect(analyses.find(1)).toBeNull();
    });

    it('gives up after the retry limit so one bad trade cannot block the queue', async () => {
      llm.reply = 'not json';
      trades.insert(trade());

      for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS + 2; i++) await service.runOnce();

      expect(llm.calls).toHaveLength(MAX_ANALYSIS_ATTEMPTS);
      expect(analyses.countPending()).toBe(0);
    });

    it('swallows a throwing model rather than propagating', async () => {
      llm.throws = new Error('ollama exploded');
      trades.insert(trade());

      await expect(service.runOnce()).resolves.toBe(0);
      expect(service.status.lastError).toContain('ollama exploded');
    });

    it('recovers on a later pass once the model behaves', async () => {
      llm.reply = 'garbage';
      trades.insert(trade());
      await service.runOnce();

      llm.reply = GOOD_REPLY;
      expect(await service.runOnce()).toBe(1);
      expect(analyses.find(1)?.verdict).toBe('sound_process_lost');
      // The earlier failure record is cleared once it succeeds.
      expect(analyses.countPending()).toBe(0);
    });
  });

  it('logs the verdict as an engine event', async () => {
    trades.insert(trade());
    await service.runOnce();
    expect(events.recent().some((e) => e.kind === 'trade_analysed')).toBe(true);
  });

  it('reports its own state for the dashboard', async () => {
    trades.insert(trade());
    expect(service.status.pending).toBe(1);
    await service.runOnce();
    expect(service.status.analysed).toBe(1);
    expect(service.status.model).toBe('fake-model');
  });

  describe('when disabled', () => {
    beforeEach(async () => {
      await moduleRef.close();
      await build({ POSTMORTEM_ENABLED: 'false' });
    });

    it('never starts its timer', () => {
      service.onApplicationBootstrap();
      expect(service.status.enabled).toBe(false);
    });
  });
});
