import { Global, Module } from '@nestjs/common';
import {
  CryptoPanicClient,
  NullNewsProvider,
  OllamaClient,
  type LlmClient,
  type NewsProvider,
} from '@crypto-magic/insight';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { childLogger } from '../common/logger';
import { LLM_CLIENT, NEWS_PROVIDER } from './tokens';

/**
 * Builds the optional insight dependencies.
 *
 * Both are nullable by design. The engine trades perfectly well with neither,
 * and everything downstream is written to expect null rather than to assume a
 * model is there.
 */
export function createLlmClient(config: AppConfig): LlmClient | null {
  if (!config.LLM_ENABLED) return null;
  childLogger('insight').info(
    { model: config.OLLAMA_MODEL, baseUrl: config.OLLAMA_BASE_URL },
    'local LLM enabled for trade post-mortems',
  );
  return new OllamaClient({
    baseUrl: config.OLLAMA_BASE_URL,
    model: config.OLLAMA_MODEL,
    defaultTimeoutMs: config.LLM_TIMEOUT_MS,
    keepAlive: config.OLLAMA_KEEP_ALIVE,
  });
}

export function createNewsProvider(config: AppConfig): NewsProvider {
  if (!config.NEWS_ENABLED || !config.CRYPTOPANIC_API_KEY) return new NullNewsProvider();
  return new CryptoPanicClient({
    apiKey: config.CRYPTOPANIC_API_KEY,
    plan: config.CRYPTOPANIC_PLAN,
    ...(config.CRYPTOPANIC_BASE_URL ? { baseUrl: config.CRYPTOPANIC_BASE_URL } : {}),
  });
}

@Global()
@Module({
  providers: [
    { provide: LLM_CLIENT, useFactory: createLlmClient, inject: [APP_CONFIG] },
    { provide: NEWS_PROVIDER, useFactory: createNewsProvider, inject: [APP_CONFIG] },
  ],
  exports: [LLM_CLIENT, NEWS_PROVIDER],
})
export class InsightModule {}
