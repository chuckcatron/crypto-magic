import type { NewsItem, NewsProvider, NewsQuery } from './types';

export type CryptoPanicPlan = 'developer' | 'growth' | 'enterprise';

export interface CryptoPanicOptions {
  readonly apiKey: string;
  /**
   * The plan segment in the URL. CryptoPanic's v2 API is served from
   * /api/{plan}/v2/, and per-currency filtering is only available from
   * Developer upward — on a plan without it the API ignores `currencies` and
   * returns the unfiltered firehose, so we filter again client-side.
   */
  readonly plan?: CryptoPanicPlan;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

interface CryptoPanicPost {
  id?: number;
  title?: string;
  url?: string;
  original_url?: string;
  published_at?: string;
  created_at?: string;
  source?: { title?: string; domain?: string };
  instruments?: { code?: string }[];
  votes?: { positive?: number; negative?: number; important?: number };
}

/**
 * CryptoPanic v2 news client.
 *
 * Every field is treated as optional. This is an aggregator of third-party
 * feeds, its shape has changed across versions, and the cost of being wrong
 * about a field is a missing headline in a post-mortem — so the parser skips
 * anything malformed instead of throwing.
 */
export class CryptoPanicClient implements NewsProvider {
  readonly name = 'cryptopanic';
  readonly isConfigured: boolean;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: CryptoPanicOptions) {
    this.apiKey = options.apiKey ?? '';
    this.isConfigured = this.apiKey.length > 0;
    const plan = options.plan ?? 'developer';
    this.baseUrl = (options.baseUrl ?? `https://cryptopanic.com/api/${plan}/v2`).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async headlines(query: NewsQuery): Promise<NewsItem[]> {
    if (!this.isConfigured) return [];

    const url = new URL(`${this.baseUrl}/posts/`);
    url.searchParams.set('auth_token', this.apiKey);
    if (query.symbols.length > 0) url.searchParams.set('currencies', query.symbols.join(','));
    url.searchParams.set('public', 'true');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return [];

      const payload = (await response.json()) as { results?: CryptoPanicPost[] };
      const symbols = new Set(query.symbols.map((s) => s.toUpperCase()));

      return (payload.results ?? [])
        .map((post) => toNewsItem(post))
        .filter((item): item is NewsItem & { symbols: string[] } => item !== null)
        // The API returns recent posts, not a time range, so the trade's window
        // is applied here.
        .filter((item) => item.publishedAt >= query.since && item.publishedAt <= query.until)
        .filter((item) => item.symbols.length === 0 || item.symbols.some((s) => symbols.has(s)))
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, query.limit ?? 12)
        .map(({ symbols: _ignored, ...item }) => item);
    } catch {
      // Never propagate. News is decoration on a post-mortem; a failure here
      // must not surface anywhere near the engine.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

function toNewsItem(post: CryptoPanicPost): (NewsItem & { symbols: string[] }) | null {
  const title = post.title?.trim();
  if (!title) return null;

  const published = Date.parse(post.published_at ?? post.created_at ?? '');
  if (!Number.isFinite(published)) return null;

  return {
    id: String(post.id ?? `${published}-${title.slice(0, 32)}`),
    title,
    url: post.original_url || post.url || '',
    source: post.source?.title || post.source?.domain || 'unknown',
    publishedAt: published,
    symbols: (post.instruments ?? [])
      .map((i) => i.code?.toUpperCase())
      .filter((c): c is string => Boolean(c)),
    ...(post.votes
      ? {
          votes: {
            positive: post.votes.positive ?? 0,
            negative: post.votes.negative ?? 0,
            important: post.votes.important ?? 0,
          },
        }
      : {}),
  };
}

/** A provider that returns nothing, used when news is switched off. */
export class NullNewsProvider implements NewsProvider {
  readonly name = 'none';
  readonly isConfigured = false;
  async headlines(): Promise<NewsItem[]> {
    return [];
  }
}
