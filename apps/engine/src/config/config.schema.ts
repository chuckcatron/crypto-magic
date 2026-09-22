import { GRANULARITIES } from '@crypto-magic/core';
import { z } from 'zod';

/** Phrase the operator must type to arm live trading. Anything else stays paper. */
export const LIVE_TRADING_ACK = 'I_UNDERSTAND_THIS_SPENDS_REAL_MONEY';

const csv = (value: string) =>
  value
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

const numeric = (fallback: number) =>
  z.coerce.number().refine(Number.isFinite, 'must be a finite number').default(fallback);

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .transform((v) => v === 'true' || v === '1' || v === 'yes')
    .default(fallback ? 'true' : 'false');

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    // --- Execution mode -----------------------------------------------------
    TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
    LIVE_TRADING_ACK: z.string().optional(),

    // --- Credentials --------------------------------------------------------
    COINBASE_API_KEY_NAME: z.string().optional(),
    COINBASE_API_PRIVATE_KEY: z.string().optional(),

    // --- Market -------------------------------------------------------------
    PRODUCTS: z.string().default('BTC-USD').transform(csv),
    GRANULARITY: z.enum(GRANULARITIES).default('ONE_HOUR'),
    QUOTE_CURRENCY: z.string().default('USD').transform((s) => s.toUpperCase()),

    // --- Risk limits --------------------------------------------------------
    MAX_TOTAL_NOTIONAL: numeric(100),
    MAX_POSITION_NOTIONAL: numeric(25),
    MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).default(4),
    RISK_PER_TRADE_PCT: numeric(1),
    MAX_DAILY_LOSS: numeric(10),
    MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().min(1).default(4),
    MAX_ORDERS_PER_HOUR: z.coerce.number().int().min(1).default(12),
    MAX_SLIPPAGE_PCT: numeric(0.5),
    MIN_ORDER_NOTIONAL: numeric(1),

    // --- Strategy -----------------------------------------------------------
    EMA_FAST_PERIOD: z.coerce.number().int().min(2).default(12),
    EMA_SLOW_PERIOD: z.coerce.number().int().min(3).default(26),
    EMA_TREND_PERIOD: z.coerce.number().int().min(10).default(200),
    RSI_PERIOD: z.coerce.number().int().min(2).default(14),
    RSI_ENTRY_MAX: numeric(80),
    RSI_ENTRY_MIN: numeric(45),
    RSI_EXIT_MAX: numeric(88),
    ATR_PERIOD: z.coerce.number().int().min(2).default(14),
    ATR_STOP_MULTIPLE: numeric(2),
    ATR_TAKE_PROFIT_MULTIPLE: numeric(4),
    MIN_ATR_PCT: numeric(0.15),
    MAX_ATR_PCT: numeric(8),
    REQUIRE_TREND_FILTER: bool(true),
    MIN_CONFIDENCE: numeric(0.35),

    // --- Position management ------------------------------------------------
    TRAILING_STOP_ENABLED: bool(true),
    TRAIL_ACTIVATION_ATR_MULTIPLE: numeric(1),
    MAX_HOLDING_BARS: z.coerce.number().int().min(1).default(240),
    /** Exchange-side stop placed this many ATRs below the engine's own stop. */
    PROTECTIVE_STOP_ENABLED: bool(true),
    PROTECTIVE_STOP_SLACK_ATR: numeric(0.5),

    // --- Loop timing --------------------------------------------------------
    /** How often to re-check stops against the live ticker, in seconds. */
    STOP_MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(30),
    /**
     * Refuse to trade when the newest CLOSED bar is older than this many bars.
     *
     * Measured in bars rather than seconds on purpose: the newest closed bar is
     * always up to one full interval old, so any fixed second-count small enough
     * to catch a stalled 1-minute feed would permanently halt hourly trading.
     * A value of 2 means "we missed a bar".
     */
    MAX_MARKET_DATA_AGE_BARS: z.coerce.number().min(1).default(2),

    // --- Runtime ------------------------------------------------------------
    DATABASE_PATH: z.string().default('./data/crypto-magic.db'),
    KILL_SWITCH_FILE: z.string().default('./data/KILL_SWITCH'),
    PAPER_STARTING_CASH: numeric(1000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.TRADING_MODE === 'live') {
      // Three independent things must all be true before real money moves.
      if (cfg.LIVE_TRADING_ACK !== LIVE_TRADING_ACK) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LIVE_TRADING_ACK'],
          message:
            `TRADING_MODE=live also requires LIVE_TRADING_ACK=${LIVE_TRADING_ACK}. ` +
            'This is intentional: live mode must never be reachable by flipping one variable.',
        });
      }
      if (!cfg.COINBASE_API_KEY_NAME || !cfg.COINBASE_API_PRIVATE_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['COINBASE_API_KEY_NAME'],
          message: 'live trading requires COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY',
        });
      }
    }
    if (cfg.EMA_FAST_PERIOD >= cfg.EMA_SLOW_PERIOD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMA_FAST_PERIOD'],
        message: 'EMA_FAST_PERIOD must be shorter than EMA_SLOW_PERIOD',
      });
    }
    if (cfg.MAX_POSITION_NOTIONAL > cfg.MAX_TOTAL_NOTIONAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAX_POSITION_NOTIONAL'],
        message: 'MAX_POSITION_NOTIONAL cannot exceed MAX_TOTAL_NOTIONAL',
      });
    }
    if (cfg.RSI_ENTRY_MIN >= cfg.RSI_ENTRY_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RSI_ENTRY_MIN'],
        message: 'RSI_ENTRY_MIN must be below RSI_ENTRY_MAX',
      });
    }
    if (cfg.MIN_ATR_PCT >= cfg.MAX_ATR_PCT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MIN_ATR_PCT'],
        message: 'MIN_ATR_PCT must be below MAX_ATR_PCT',
      });
    }
    if (cfg.PRODUCTS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PRODUCTS'],
        message: 'at least one product is required',
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Parse and validate the environment. Throws with every problem listed at once,
 * because discovering misconfiguration one variable at a time while a bot is
 * failing to start is miserable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
