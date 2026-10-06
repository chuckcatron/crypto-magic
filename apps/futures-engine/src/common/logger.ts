import pino, { type Logger } from 'pino';

let root: Logger | null = null;

/** Structured JSON logs, as in the regime engine. Alert credentials are redacted. */
export function rootLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  root ??= pino({
    level,
    base: { app: 'futures-paper' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'NTFY_TOPIC',
        'DISCORD_WEBHOOK_URL',
        'TELEGRAM_BOT_TOKEN',
        '*.webhookUrl',
        '*.botToken',
      ],
      censor: '[redacted]',
    },
    ...(process.stdout.isTTY
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
  return root;
}

export function childLogger(name: string): Logger {
  return rootLogger().child({ context: name });
}
