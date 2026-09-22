import { Global, Module } from '@nestjs/common';
import { CoinbaseAdapter, PaperAdapter, type ExchangeAdapter } from '@crypto-magic/exchange';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config.schema';
import { childLogger } from '../common/logger';

import { EXCHANGE } from './tokens';

export { EXCHANGE };

/**
 * Build the one adapter the engine will use.
 *
 * In paper mode the engine is handed a PaperAdapter whose market data comes from
 * a Coinbase adapter built WITHOUT credentials. That adapter throws on every
 * order method, so paper mode cannot reach a real order even if something above
 * it is badly wrong.
 */
export function createExchange(config: AppConfig): ExchangeAdapter {
  const log = childLogger('exchange');

  if (config.TRADING_MODE === 'live') {
    log.warn(
      { products: config.PRODUCTS, maxTotalNotional: config.MAX_TOTAL_NOTIONAL },
      'LIVE TRADING ENABLED — orders will spend real money',
    );
    return new CoinbaseAdapter({
      apiKey: config.COINBASE_API_KEY_NAME!,
      apiSecret: config.COINBASE_API_PRIVATE_KEY!,
    });
  }

  // Credentials are passed through when present so paper mode can still read
  // private endpoints if you want it to, but they are not required.
  const marketData = new CoinbaseAdapter({
    ...(config.COINBASE_API_KEY_NAME && config.COINBASE_API_PRIVATE_KEY
      ? { apiKey: config.COINBASE_API_KEY_NAME, apiSecret: config.COINBASE_API_PRIVATE_KEY }
      : {}),
  });

  log.info(
    { authenticated: marketData.authenticated, startingCash: config.PAPER_STARTING_CASH },
    'paper mode: real market data, simulated money',
  );

  return new PaperAdapter({
    marketData,
    initialBalances: { [config.QUOTE_CURRENCY]: config.PAPER_STARTING_CASH },
  });
}

@Global()
@Module({
  providers: [{ provide: EXCHANGE, useFactory: createExchange, inject: [APP_CONFIG] }],
  exports: [EXCHANGE],
})
export class ExchangeModule {}
