import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/tokens';
import type { AppConfig } from './config/config.schema';
import { childLogger, rootLogger } from './common/logger';

async function bootstrap(): Promise<void> {
  const log = childLogger('bootstrap');

  const app = await NestFactory.create(AppModule, {
    // Nest's own logger is noisy and unstructured; everything that matters goes
    // through pino instead.
    logger: ['error', 'warn'],
    // Give in-flight orders a chance to finish before the process exits.
    abortOnError: false,
  });
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);

  // The dashboard runs on the same machine. Nothing here is authenticated, so
  // nothing here is exposed beyond the loopback interface.
  app.enableCors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] });
  await app.listen(config.PORT, '127.0.0.1');

  log.info(
    { port: config.PORT, mode: config.TRADING_MODE },
    `engine API listening on http://127.0.0.1:${config.PORT}`,
  );
}

bootstrap().catch((error: unknown) => {
  rootLogger().fatal({ err: error instanceof Error ? error.message : String(error) }, 'failed to start');
  process.exitCode = 1;
});
