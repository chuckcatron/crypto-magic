import { VERDICTS, type PostMortemAnalysis, type PostMortemInput, type Verdict } from './types';

/** Guards against a runaway local model filling the database with one row. */
const MAX_SUMMARY = 600;
const MAX_ITEM = 240;
const MAX_ITEMS = 4;

const SYSTEM_PROMPT = `You review closed trades from an automated cryptocurrency trading bot.

The bot runs one strategy: a long-only trend follower on spot. It enters when a
fast EMA crosses above a slow EMA, price is above a long trend EMA, RSI is in a
band, and volatility is in a tradable range. It exits on the mirror cross, a
blow-off RSI reading, an ATR stop, an ATR target, or a maximum holding period.
It cannot short, use leverage, or average down.

Judge PROCESS and OUTCOME separately. This is the most important thing you do:

- A trade that followed the strategy and lost money is SOUND process. Losing
  trades are the normal cost of a trend-following system and are not mistakes.
- A trade that deviated from the strategy and made money is FLAWED process. It
  got lucky, and it is more dangerous than an ordinary loss.

Judge only what the data shows. You are given the exact reasons the bot entered,
the exit reason, and the prices. If something cannot be determined from that,
say so rather than inventing a cause. Never speculate about what the market
"was going to do", and never recommend a different strategy — your job is to
assess this trade against the rules the bot actually follows.

Be concise and specific. Refer to the real numbers. No preamble, no hedging
filler, no restating the question.

Respond ONLY with a JSON object of exactly this shape:
{
  "verdict": one of ${VERDICTS.map((v) => `"${v}"`).join(' | ')},
  "summary": "one or two sentences",
  "whatWorked": ["short point", ...],
  "whatDidnt": ["short point", ...],
  "lesson": "one transferable lesson, or null if unremarkable",
  "usedNews": true or false
}`;

export function buildPostMortemPrompt(input: PostMortemInput): { system: string; user: string } {
  const held = formatDuration(input.exitTime - input.entryTime);
  const direction = Number.parseFloat(input.pnl) >= 0 ? 'profit' : 'loss';

  const lines = [
    `TRADE — ${input.productId} (long)`,
    ``,
    `Entered  ${new Date(input.entryTime).toISOString()} at ${input.entryPrice}`,
    `Exited   ${new Date(input.exitTime).toISOString()} at ${input.exitPrice}`,
    `Held     ${held}`,
    `Size     ${input.baseSize}`,
    `Result   ${input.pnl} (${input.pnlPct.toFixed(2)}%) — a ${direction}, net of ${input.fees} in fees`,
    ``,
    `Exit reason: ${input.exitReason}`,
    input.stopPrice ? `Stop was at ${input.stopPrice}` : null,
    input.takeProfitPrice ? `Target was at ${input.takeProfitPrice}` : null,
    ``,
    `The bot entered because:`,
    ...input.entryReasons.map((reason) => `  - ${reason}`),
    `Signal confidence at entry: ${input.confidence.toFixed(2)} (0-1, scales position size)`,
  ].filter((line): line is string => line !== null);

  if (input.news.length > 0) {
    lines.push(
      ``,
      `HEADLINES published while this trade was open (context only — the bot did`,
      `NOT see these and they played no part in the decision):`,
      ...input.news.map(
        (item) =>
          `  - [${new Date(item.publishedAt).toISOString().slice(0, 16).replace('T', ' ')}] ${item.title} (${item.source})`,
      ),
      ``,
      `If a headline plausibly explains the price action, say so. If none does,`,
      `set usedNews to false and do not force a connection.`,
    );
  } else {
    lines.push(``, `No headlines available for this window. Set usedNews to false.`);
  }

  return { system: SYSTEM_PROMPT, user: lines.join('\n') };
}

/**
 * Parse a local model's reply into an analysis, or null.
 *
 * Small local models wrap JSON in prose, in markdown fences, or emit a trailing
 * comma. Every one of those should cost us a post-mortem, never an exception —
 * so this is deliberately forgiving about shape and strict about content.
 */
export function parsePostMortemResponse(raw: string): PostMortemAnalysis | null {
  const json = extractJsonObject(raw);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const verdict = normalizeVerdict(record.verdict);
  const summary = clean(record.summary, MAX_SUMMARY);

  // A verdict with no summary is not an analysis, it is a label.
  if (!verdict || !summary) return null;

  return {
    verdict,
    summary,
    whatWorked: toList(record.whatWorked),
    whatDidnt: toList(record.whatDidnt),
    lesson: clean(record.lesson, MAX_ITEM) || null,
    usedNews: record.usedNews === true,
  };
}

/** Pull the first balanced {...} out of whatever the model wrapped it in. */
function extractJsonObject(raw: string): string | null {
  const text = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function normalizeVerdict(value: unknown): Verdict | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (VERDICTS as readonly string[]).includes(normalized) ? (normalized as Verdict) : null;
}

function clean(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function toList(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return source
    .map((item) => clean(item, MAX_ITEM))
    .filter((item) => item.length > 0)
    .slice(0, MAX_ITEMS);
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
