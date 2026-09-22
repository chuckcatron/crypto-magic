import { describe, expect, it } from 'vitest';
import { CoinbaseAdapter, PaperAdapter } from '@crypto-magic/exchange';
import { loadConfig } from '../config/config.schema';
import { createExchange } from './exchange.module';

const withLiveKeys = {
  COINBASE_API_KEY_NAME: 'organizations/x/apiKeys/y',
  COINBASE_API_PRIVATE_KEY: '-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----\n',
  LOG_LEVEL: 'fatal',
};

describe('createExchange', () => {
  it('in paper mode, builds an adapter that cannot trade EVEN WITH live keys present', () => {
    // The realistic case: keys configured for live, mode flipped back to paper.
    const exchange = createExchange(
      loadConfig({ ...withLiveKeys, TRADING_MODE: 'paper' } as NodeJS.ProcessEnv),
    );

    expect(exchange).toBeInstanceOf(PaperAdapter);
    expect(exchange.isLive).toBe(false);

    const marketData = (exchange as unknown as { options: { marketData: CoinbaseAdapter } }).options
      .marketData;
    expect(marketData.authenticated).toBe(false);
    expect(marketData.isLive).toBe(false);
  });

  it('in live mode, builds an authenticated Coinbase adapter', () => {
    const exchange = createExchange(
      loadConfig({
        ...withLiveKeys,
        TRADING_MODE: 'live',
        LIVE_TRADING_ACK: 'I_UNDERSTAND_THIS_SPENDS_REAL_MONEY',
      } as NodeJS.ProcessEnv),
    );
    expect(exchange).toBeInstanceOf(CoinbaseAdapter);
    expect(exchange.isLive).toBe(true);
  });
});
