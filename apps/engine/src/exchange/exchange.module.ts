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

  // NEVER pass credentials in paper mode, even when they are present in .env.
  //
  // This used to forward them "so paper mode can read private endpoints", which
  // it never actually does. The cost was real: the most common way to be in
  // paper mode with keys configured is having set up live and switched back to
  // test something — and in exactly that case the market-data adapter was fully
  // able to place orders, leaving only the PaperAdapter's discipline between a
  // bug and a real fill. SAFETY.md promises a structural guarantee, not a
  // disciplined one. An adapter with no credentials physically cannot trade.
  const marketData = new CoinbaseAdapter({});

  log.info(
    {
      startingCash: config.PAPER_STARTING_CASH,
      credentialsIgnored: Boolean(config.COINBASE_API_KEY_NAME && config.COINBASE_API_PRIVATE_KEY),
    },
    'paper mode: public market data, simulated money, no path to a real order',
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
