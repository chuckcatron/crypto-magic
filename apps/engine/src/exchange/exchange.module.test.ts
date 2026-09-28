import { describe, expect, it } from 'vitest';
import { CoinbaseAdapter, PaperAdapter } from '@crypto-magic/exchange';
import { loadConfig } from '../config/config.schema';
import {
  createExchange,
  loadPaperBalances,
  PAPER_BALANCES_KEY,
  PAPER_STARTING_CASH_KEY,
} from './exchange.module';

const withLiveKeys = {
  COINBASE_API_KEY_NAME: 'organizations/x/apiKeys/y',
  COINBASE_API_PRIVATE_KEY: '-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----\n',
  LOG_LEVEL: 'fatal',
};

describe('createExchange', () => {
  it('in paper mode, builds an adapter that cannot trade EVEN WITH live keys present', () => {
    // The realistic case: keys configured for live, mode flipped back to paper.
    const exchange = createExchange(loadConfig({ ...withLiveKeys, TRADING_MODE: 'paper' }));

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
      }),
    );
    expect(exchange).toBeInstanceOf(CoinbaseAdapter);
    expect(exchange.isLive).toBe(true);
  });

  it('in paper mode, restores the simulated account saved by a previous run', async () => {
    const store = new Map<string, string>([
      [PAPER_BALANCES_KEY, '{"USD":"812.34","BTC":"0.0021"}'],
    ]);
    const state = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
    };

    const exchange = createExchange(
      loadConfig({
        TRADING_MODE: 'paper',
        PAPER_STARTING_CASH: '1000',
        LOG_LEVEL: 'fatal',
      }),
      state,
    );
    const balances = Object.fromEntries(
      (await exchange.getBalances()).map((b) => [b.currency, b.available.toFixed()]),
    );
    expect(balances).toEqual({ USD: '812.34', BTC: '0.0021' });
  });

  it('starts a fresh paper account when nothing, or something unreadable, was saved', async () => {
    for (const saved of [undefined, 'not json', '{"USD":-5}', '{"usd":"1"}', '[]', '{}']) {
      const store = new Map<string, string>(
        saved === undefined ? [] : [[PAPER_BALANCES_KEY, saved]],
      );
      const state = {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => void store.set(k, v),
      };
      const exchange = createExchange(
        loadConfig({
          TRADING_MODE: 'paper',
          PAPER_STARTING_CASH: '1000',
          LOG_LEVEL: 'fatal',
        }),
        state,
      );
      const balances = await exchange.getBalances();
      expect(
        balances.map((b) => [b.currency, b.available.toFixed()]),
        String(saved),
      ).toEqual([['USD', '1000']]);
    }
  });

  describe('recorded starting cash, the dashboard baseline', () => {
    const paper = (cash: string) =>
      loadConfig({ TRADING_MODE: 'paper', PAPER_STARTING_CASH: cash, LOG_LEVEL: 'fatal' });
    const storeWith = (entries: [string, string][]) => {
      const store = new Map(entries);
      return {
        store,
        state: {
          get: (k: string) => store.get(k) ?? null,
          set: (k: string, v: string) => void store.set(k, v),
        },
      };
    };

    it('is recorded when a fresh account is created', () => {
      const { store, state } = storeWith([]);
      createExchange(paper('1000'), state);
      expect(store.get(PAPER_STARTING_CASH_KEY)).toBe('1000');
    });

    it('is backfilled from the config for an account that predates it', () => {
      const { store, state } = storeWith([[PAPER_BALANCES_KEY, '{"USD":"4.06","BTC":"0.0117"}']]);
      createExchange(paper('1000'), state);
      expect(store.get(PAPER_STARTING_CASH_KEY)).toBe('1000');
    });

    it('is kept on restore even if the config has changed since', () => {
      // A changed PAPER_STARTING_CASH does not change a restored account's
      // balances, so it must not change what that account started with either.
      const { store, state } = storeWith([
        [PAPER_BALANCES_KEY, '{"USD":"4.06","BTC":"0.0117"}'],
        [PAPER_STARTING_CASH_KEY, '1000'],
      ]);
      createExchange(paper('5000'), state);
      expect(store.get(PAPER_STARTING_CASH_KEY)).toBe('1000');
    });

    it('is reset along with the account when the saved balances are unreadable', () => {
      const { store, state } = storeWith([
        [PAPER_BALANCES_KEY, 'not json'],
        [PAPER_STARTING_CASH_KEY, '1000'],
      ]);
      createExchange(paper('5000'), state);
      expect(store.get(PAPER_STARTING_CASH_KEY)).toBe('5000');
    });
  });

  it('accepts only currency codes mapped to non-negative decimal strings', () => {
    expect(loadPaperBalances('{"USD":"1000","BTC":"0.00000001"}')).toEqual({
      USD: '1000',
      BTC: '0.00000001',
    });
    expect(loadPaperBalances('{"USD":"1e3"}')).toBeNull();
    expect(loadPaperBalances('{"USD":1000}')).toBeNull();
    expect(loadPaperBalances(null)).toBeNull();
  });
});
