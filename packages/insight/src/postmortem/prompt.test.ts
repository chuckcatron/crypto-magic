import { describe, expect, it } from 'vitest';
import type { NewsItem } from '../news/types';
import { buildPostMortemPrompt, parsePostMortemResponse } from './prompt';
import type { PostMortemInput } from './types';

const BASE: PostMortemInput = {
  productId: 'BTC-USD',
  entryTime: Date.parse('2026-09-01T12:00:00Z'),
  exitTime: Date.parse('2026-09-02T04:00:00Z'),
  entryPrice: '61240.55',
  exitPrice: '59180.20',
  baseSize: '0.00038',
  fees: '0.28',
  pnl: '-1.06',
  pnlPct: -3.36,
  exitReason: 'stop_loss',
  entryReasons: ['EMA12 crossed above EMA26', 'price above trend EMA200'],
  confidence: 0.61,
  stopPrice: '59180.20',
  takeProfitPrice: '65360.90',
  news: [],
};

const NEWS: NewsItem[] = [
  {
    id: '1',
    title: 'Major exchange halts withdrawals',
    url: 'https://example.com/a',
    source: 'Example Wire',
    publishedAt: Date.parse('2026-09-01T18:00:00Z'),
  },
];

const valid = {
  verdict: 'sound_process_lost',
  summary: 'Rules were followed; the stop did its job.',
  whatWorked: ['stop capped the loss'],
  whatDidnt: ['entry was late in the move'],
  lesson: 'A stopped-out trend entry is a cost of business.',
  usedNews: false,
};

describe('buildPostMortemPrompt', () => {
  it('includes the numbers the model must reason over', () => {
    const { user } = buildPostMortemPrompt(BASE);
    expect(user).toContain('BTC-USD');
    expect(user).toContain('61240.55');
    expect(user).toContain('59180.20');
    expect(user).toContain('stop_loss');
    expect(user).toContain('EMA12 crossed above EMA26');
    expect(user).toContain('16h 0m');
  });

  it('separates process from outcome in the system prompt', () => {
    const { system } = buildPostMortemPrompt(BASE);
    expect(system).toContain('SOUND process');
    expect(system).toContain('FLAWED process');
  });

  it('states plainly that the bot never saw the headlines', () => {
    const { user } = buildPostMortemPrompt({ ...BASE, news: NEWS });
    expect(user).toContain('Major exchange halts withdrawals');
    // Without this the model will happily write "the bot ignored the news".
    expect(user).toMatch(/did\s*NOT see these/);
  });

  it('tells the model to expect no headlines when there are none', () => {
    const { user } = buildPostMortemPrompt(BASE);
    expect(user).toContain('No headlines available');
  });
});

describe('parsePostMortemResponse', () => {
  it('parses a clean JSON reply', () => {
    const result = parsePostMortemResponse(JSON.stringify(valid));
    expect(result).toEqual(valid);
  });

  it('survives a markdown code fence', () => {
    const result = parsePostMortemResponse('```json\n' + JSON.stringify(valid) + '\n```');
    expect(result?.verdict).toBe('sound_process_lost');
  });

  it('survives prose wrapped around the JSON', () => {
    const raw = `Sure! Here is my analysis:\n\n${JSON.stringify(valid)}\n\nHope that helps.`;
    expect(parsePostMortemResponse(raw)?.verdict).toBe('sound_process_lost');
  });

  it('handles braces inside string values without truncating', () => {
    const tricky = { ...valid, summary: 'Model wrote a { brace } in prose.' };
    expect(parsePostMortemResponse(JSON.stringify(tricky))?.summary).toBe(
      'Model wrote a { brace } in prose.',
    );
  });

  it('normalizes a verdict with different casing or separators', () => {
    expect(parsePostMortemResponse(JSON.stringify({ ...valid, verdict: 'Sound-Process-Lost' }))?.verdict)
      .toBe('sound_process_lost');
  });

  it('rejects a verdict outside the taxonomy rather than guessing', () => {
    expect(parsePostMortemResponse(JSON.stringify({ ...valid, verdict: 'pretty good' }))).toBeNull();
  });

  it('rejects a verdict with no summary, which is a label not an analysis', () => {
    expect(parsePostMortemResponse(JSON.stringify({ ...valid, summary: '   ' }))).toBeNull();
  });

  it.each([
    ['not json at all', 'I think this trade was fine, honestly.'],
    ['empty string', ''],
    ['truncated json', '{"verdict": "sound_process_lost", "summary": "it was'],
    ['an array', '[1,2,3]'],
    ['null', 'null'],
  ])('returns null for %s instead of throwing', (_label, raw) => {
    expect(() => parsePostMortemResponse(raw)).not.toThrow();
    expect(parsePostMortemResponse(raw)).toBeNull();
  });

  it('coerces a string into a single-item list', () => {
    const result = parsePostMortemResponse(JSON.stringify({ ...valid, whatWorked: 'just the stop' }));
    expect(result?.whatWorked).toEqual(['just the stop']);
  });

  it('drops non-string and empty list entries', () => {
    const result = parsePostMortemResponse(
      JSON.stringify({ ...valid, whatDidnt: ['real point', '', null, 42, '  '] }),
    );
    expect(result?.whatDidnt).toEqual(['real point']);
  });

  it('caps a runaway model so one row cannot flood the database', () => {
    const result = parsePostMortemResponse(
      JSON.stringify({
        ...valid,
        summary: 'x'.repeat(5000),
        whatWorked: Array.from({ length: 50 }, (_, i) => `point ${i}`),
      }),
    );
    expect(result!.summary.length).toBeLessThanOrEqual(600);
    expect(result!.whatWorked.length).toBeLessThanOrEqual(4);
  });

  it('treats a missing lesson as null rather than an empty string', () => {
    const { lesson: _drop, ...withoutLesson } = valid;
    expect(parsePostMortemResponse(JSON.stringify(withoutLesson))?.lesson).toBeNull();
  });

  it('only reports usedNews when the model said exactly true', () => {
    expect(parsePostMortemResponse(JSON.stringify({ ...valid, usedNews: 'yes' }))?.usedNews).toBe(false);
    expect(parsePostMortemResponse(JSON.stringify({ ...valid, usedNews: true }))?.usedNews).toBe(true);
  });
});
