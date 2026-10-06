import './config/load-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { rootLogger } from './common/logger';
import { serveThenTrade } from './serve';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  await serveThenTrade(app);
}

bootstrap().catch((error: unknown) => {
  const inUse = error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
  rootLogger().fatal(
    { err: error instanceof Error ? error.message : String(error) },
    inUse
      ? 'failed to start: the port is taken, probably by another futures engine'
      : 'failed to start',
  );
  process.exitCode = 1;
});
