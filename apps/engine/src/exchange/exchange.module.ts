import { Global, Module } from '@nestjs/common';
import { CoinbaseAdapter, PaperAdapter, type ExchangeAdapter } from '@crypto-magic/exchange';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config.schema';
import { childLogger } from '../common/logger';
import { StateRepository } from '../persistence/repositories/state.repository';
import type { StateStore } from '../persistence/ports';

import { EXCHANGE } from './tokens';

export { EXCHANGE };

/** Where the simulated account lives between restarts. */
export const PAPER_BALANCES_KEY = 'paper:balances';

/**
 * Build the one adapter the engine will use.
 *
 * In paper mode the engine is handed a PaperAdapter whose market data comes from
 * a Coinbase adapter built WITHOUT credentials. That adapter throws on every
 * order method, so paper mode cannot reach a real order even if something above
 * it is badly wrong.
 */
export function createExchange(
  config: AppConfig,
  state?: Pick<StateStore, 'get' | 'set'>,
): ExchangeAdapter {
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
  return createPaperAdapter(config, new CoinbaseAdapter({}), state);
}

/**
 * The simulated account, restored from and saved to `state` when given.
 * Separate from createExchange so tests can drive it with fake market data.
 */
export function createPaperAdapter(
  config: AppConfig,
  marketData: ExchangeAdapter,
  state?: Pick<StateStore, 'get' | 'set'>,
): PaperAdapter {
  const log = childLogger('exchange');

  // The paper account must survive restarts. Before this, every launchd restart,
  // reboot or migration reset cash to PAPER_STARTING_CASH, and reconciliation
  // then deleted any open paper position as "closed outside the bot" — a month
  // of paper trading could not survive a power cut.
  const saved = state ? loadPaperBalances(state.get(PAPER_BALANCES_KEY)) : null;
  if (state && state.get(PAPER_BALANCES_KEY) !== null && !saved) {
    log.error('saved paper balances are unreadable; starting a fresh paper account');
  }

  log.info(
    {
      startingCash: config.PAPER_STARTING_CASH,
      restoredBalances: saved ?? undefined,
      credentialsIgnored: Boolean(config.COINBASE_API_KEY_NAME && config.COINBASE_API_PRIVATE_KEY),
    },
    saved
      ? 'paper mode: restored the simulated account from the database'
      : 'paper mode: public market data, simulated money, no path to a real order',
  );

  return new PaperAdapter({
    marketData,
    initialBalances: saved ?? { [config.QUOTE_CURRENCY]: config.PAPER_STARTING_CASH },
    onBalancesChanged: state
      ? (balances) => {
          try {
            state.set(PAPER_BALANCES_KEY, JSON.stringify(balances));
          } catch (error) {
            // Never fail a fill over bookkeeping; the next fill saves again.
            log.error({ err: String(error) }, 'could not save paper balances');
          }
        }
      : undefined,
  });
}

/** Parse saved balances, or null if they are missing or not all decimal strings. */
export function loadPaperBalances(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    const valid = entries.every(
      ([currency, amount]) =>
        /^[A-Z0-9]+$/.test(currency) && typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount),
    );
    return valid && entries.length > 0 ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: EXCHANGE,
      useFactory: (config: AppConfig, state: StateRepository) => createExchange(config, state),
      inject: [APP_CONFIG, StateRepository],
    },
  ],
  exports: [EXCHANGE],
})
export class ExchangeModule {}
