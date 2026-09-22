import type { NewsItem } from '../news/types';

/**
 * Process and outcome, judged separately.
 *
 * This is the whole point of the exercise. A trade that followed the rules and
 * lost money is a GOOD trade — that is what a 45%-win-rate strategy feels like
 * from the inside. A trade that broke the rules and made money is a BAD trade
 * that got lucky, and it is the more dangerous of the two, because it teaches
 * you to break the rules again.
 *
 * Collapsing these into "was it a winner" is how people talk themselves out of
 * a working system after a normal losing streak.
 */
export const VERDICTS = [
  'sound_process_won',
  'sound_process_lost',
  'flawed_process_won',
  'flawed_process_lost',
] as const;

export type Verdict = (typeof VERDICTS)[number];

export interface PostMortemAnalysis {
  readonly verdict: Verdict;
  /** One or two sentences. */
  readonly summary: string;
  readonly whatWorked: string[];
  readonly whatDidnt: string[];
  /** A single transferable lesson, or null when the trade was unremarkable. */
  readonly lesson: string | null;
  /** True when headlines were supplied and the model referenced them. */
  readonly usedNews: boolean;
}

export interface PostMortemInput {
  readonly productId: string;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryPrice: string;
  readonly exitPrice: string;
  readonly baseSize: string;
  readonly fees: string;
  readonly pnl: string;
  readonly pnlPct: number;
  readonly exitReason: string;
  readonly entryReasons: string[];
  readonly confidence: number;
  readonly stopPrice: string | null;
  readonly takeProfitPrice: string | null;
  readonly news: NewsItem[];
}
