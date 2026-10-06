import './config/load-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { localOnly } from './api/local-only';
import { AppModule } from './app.module';
import { childLogger, rootLogger } from './common/logger';
import { FUTURES_CONFIG, type FuturesConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const log = childLogger('bootstrap');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  const config = app.get<FuturesConfig>(FUTURES_CONFIG);
  // No CORS and loopback only, like the regime engine; see api/local-only.ts.
  app.use(localOnly);
  await app.listen(config.FUTURES_PORT, '127.0.0.1');
  log.info(
    { port: config.FUTURES_PORT, db: config.FUTURES_DB_PATH },
    `futures PAPER engine on http://127.0.0.1:${config.FUTURES_PORT}/api/status`,
  );
}

bootstrap().catch((error: unknown) => {
  rootLogger().fatal(
    { err: error instanceof Error ? error.message : String(error) },
    'failed to start',
  );
  process.exitCode = 1;
});
