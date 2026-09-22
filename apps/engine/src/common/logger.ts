import pino, { type Logger } from 'pino';

let root: Logger | null = null;

/**
 * Structured logging. Every trading decision and every order is logged as JSON
 * so a bad day can be reconstructed exactly, not guessed at from prose.
 */
export function rootLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  root ??= pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    // Never let a key or a private key PEM reach the log file.
    redact: {
      paths: [
        'apiKey',
        'apiSecret',
        'COINBASE_API_KEY_NAME',
        'COINBASE_API_PRIVATE_KEY',
        'CRYPTOPANIC_API_KEY',
        'DISCORD_WEBHOOK_URL',
        'TELEGRAM_BOT_TOKEN',
        'NTFY_TOPIC',
        'LIVE_TRADING_ACK',
        '*.apiSecret',
        '*.privateKey',
        '*.apiKey',
        '*.botToken',
        '*.webhookUrl',
      ],
      censor: '[redacted]',
    },
    ...(process.stdout.isTTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
  return root;
}

export function childLogger(name: string): Logger {
  return rootLogger().child({ context: name });
}
