export interface NewsItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly publishedAt: number;
  /**
   * Crowd sentiment from the aggregator, where offered. This is readers voting,
   * not an assessment of the news — treat it as a weak hint, never a signal.
   */
  readonly votes?: { positive: number; negative: number; important: number };
}

export interface NewsQuery {
  /** Base asset codes, e.g. ['BTC']. */
  readonly symbols: string[];
  readonly since: number;
  readonly until: number;
  readonly limit?: number;
}

/**
 * A source of headlines.
 *
 * Nothing in this system lets news reach a trading decision. It is context
 * attached to a post-mortem AFTER a trade has closed, which is why a provider
 * that fails, rate-limits or returns nothing is never an error worth halting
 * for — the post-mortem simply runs without it.
 */
export interface NewsProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  headlines(query: NewsQuery): Promise<NewsItem[]>;
}
