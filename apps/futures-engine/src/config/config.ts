import { z } from 'zod';
import { resolveFromRoot } from './paths';

const STRATEGY_IDS = ['F1', 'F2', 'F3', 'F4'] as const;
export type PaperStrategyId = (typeof STRATEGY_IDS)[number];

/**
 * Settings for the futures paper engine. Everything is FUTURES_-prefixed so it
 * can share the regime engine's .env without either reading the other's
 * settings. Only the alert channels are shared, on purpose.
 */
export const futuresConfigSchema = z
  .object({
    FUTURES_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
    FUTURES_DB_PATH: z.string().default('data/futures-paper.db'),
    /** Present = no new paper entries. Exits still run. */
    FUTURES_KILL_SWITCH_PATH: z.string().default('data/FUTURES_KILL_SWITCH'),
    FUTURES_STRATEGIES: z
      .string()
      .default('F1,F2,F3,F4')
      .transform((raw, ctx) => {
        const ids = raw
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);
        for (const id of ids) {
          if (!(STRATEGY_IDS as readonly string[]).includes(id)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown strategy ${id}` });
          }
        }
        return [...new Set(ids)] as PaperStrategyId[];
      }),
    /** Paper equity each sub-account starts with. */
    FUTURES_PAPER_EQUITY: z.coerce.number().positive().default(10_000),
    FUTURES_POLL_SECONDS: z.coerce.number().int().min(5).default(20),
    FUTURES_ALERT_MIN_SEVERITY: z.enum(['info', 'warning', 'critical']).default('warning'),

    // Shared with the regime engine.
    DISCORD_WEBHOOK_URL: z.string().url().optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    NTFY_TOPIC: z.string().optional(),
    NTFY_SERVER: z.string().url().default('https://ntfy.sh'),
    ALERT_COOLDOWN_SECONDS: z.coerce.number().int().min(30).default(900),
    ALERT_MAX_PER_HOUR: z.coerce.number().int().min(1).default(12),
  })
  .transform((cfg) => ({
    ...cfg,
    FUTURES_DB_PATH: resolveFromRoot(cfg.FUTURES_DB_PATH),
    FUTURES_KILL_SWITCH_PATH: resolveFromRoot(cfg.FUTURES_KILL_SWITCH_PATH),
  }));

export type FuturesConfig = z.infer<typeof futuresConfigSchema>;

export const FUTURES_CONFIG = Symbol('FUTURES_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FuturesConfig {
  const parsed = futuresConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid futures engine settings: ${issues}`);
  }
  return parsed.data;
}
