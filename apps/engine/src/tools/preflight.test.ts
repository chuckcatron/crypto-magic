import { describe, expect, it } from 'vitest';
import { D } from '@crypto-magic/core';
import { evaluatePreflight, firstBuyEstimate, type PreflightInput } from './preflight';

const config: PreflightInput['config'] = {
  TRADING_MODE: 'paper',
  PRODUCTS: ['BTC-USD'],
  QUOTE_CURRENCY: 'USD',
  STRATEGY: 'regime',
  GRANULARITY: 'ONE_DAY',
  REGIME_ALLOCATION_PCT: 99,
  MAX_TOTAL_NOTIONAL: 500,
  MAX_POSITION_NOTIONAL: 500,
  MIN_ORDER_NOTIONAL: 1,
  MAX_CONSECUTIVE_LOSSES: 12,
  PROTECTIVE_STOP_ENABLED: true,
  HEARTBEAT_ENABLED: true,
  DEADMAN_PING_URL: 'https://hc-ping.com/x',
  DISCORD_WEBHOOK_URL: undefined,
  TELEGRAM_BOT_TOKEN: undefined,
  TELEGRAM_CHAT_ID: undefined,
  NTFY_TOPIC: 'my-topic',
  COINBASE_API_KEY_NAME: 'organizations/o/apiKeys/k',
  COINBASE_API_PRIVATE_KEY: 'pem',
};

/** A portfolio that passes everything: $500, no BTC, safe key, fresh database. */
const ready: PreflightInput = {
  config,
  permissions: {
    canView: true,
    canTrade: true,
    canTransfer: false,
    portfolioUuid: 'p-1',
    portfolioType: 'CONSUMER',
  },
  balances: [
    { currency: 'USD', available: D(500), hold: D(0) },
    { currency: 'BTC', available: D(0), hold: D(0) },
  ],
  feeTier: {
    pricingTier: 'Advanced 1',
    takerFeeRate: D('0.006'),
    makerFeeRate: D('0.004'),
    volume30dUsd: D(0),
  },
  baseCurrencies: { 'BTC-USD': 'BTC' },
  databaseExists: false,
  databasePath: '/repo/data/crypto-magic.db',
  env: { privateToOwner: true, gitIgnored: true },
};

const statusOf = (input: PreflightInput, title: string) =>
  evaluatePreflight(input).find((c) => c.title === title)?.status;
const failures = (input: PreflightInput) =>
  evaluatePreflight(input)
    .filter((c) => c.status === 'FAIL')
    .map((c) => c.title);

describe('evaluatePreflight', () => {
  it('passes a correctly prepared account with no failures or warnings', () => {
    const checks = evaluatePreflight(ready);
    expect(checks.filter((c) => c.status !== 'PASS')).toEqual([]);
  });

  it('fails a key that can move money off the exchange', () => {
    const input = {
      ...ready,
      permissions: { ...(ready.permissions as object), canTransfer: true },
    };
    expect(failures(input as PreflightInput)).toContain('Key cannot transfer or withdraw');
  });

  it('fails a key that cannot trade', () => {
    const input = { ...ready, permissions: { ...(ready.permissions as object), canTrade: false } };
    expect(failures(input as PreflightInput)).toContain('Key can view and trade');
  });

  it('fails when the portfolio already holds the coin the bot would trade', () => {
    // Reconciliation would later adopt all of it as the bot's position.
    const input = {
      ...ready,
      balances: [
        { currency: 'USD', available: D(500), hold: D(0) },
        { currency: 'BTC', available: D('0.4'), hold: D(0) },
      ],
    };
    const check = evaluatePreflight(input).find((c) => c.title === 'No BTC the bot did not buy');
    expect(check?.status).toBe('FAIL');
    expect(check?.detail).toMatch(/adopts all of it/);
  });

  it('counts coins on hold, not just available ones', () => {
    const input = {
      ...ready,
      balances: [
        { currency: 'USD', available: D(500), hold: D(0) },
        { currency: 'BTC', available: D(0), hold: D('0.01') },
      ],
    };
    expect(statusOf(input, 'No BTC the bot did not buy')).toBe('FAIL');
  });

  it('fails when an old database would mix paper positions into live', () => {
    expect(failures({ ...ready, databaseExists: true })).toContain('Fresh database');
  });

  it('fails with no alert channel', () => {
    expect(failures({ ...ready, config: { ...config, NTFY_TOPIC: undefined } })).toContain(
      'Alert channel',
    );
  });

  it('fails with no credentials, and when Coinbase rejects them', () => {
    const none = { ...ready, config: { ...config, COINBASE_API_KEY_NAME: undefined } };
    expect(failures(none)).toContain('API credentials');
    const refused = { ...ready, permissions: { error: 'HTTP 401 Unauthorized' } };
    expect(evaluatePreflight(refused).find((c) => c.title === 'API credentials')?.detail).toMatch(
      /401/,
    );
  });

  it('fails when .env is not git-ignored, and warns when others can read it', () => {
    expect(failures({ ...ready, env: { privateToOwner: true, gitIgnored: false } })).toContain(
      '.env is git-ignored',
    );
    expect(
      statusOf(
        { ...ready, env: { privateToOwner: false, gitIgnored: true } },
        '.env readable only by you',
      ),
    ).toBe('WARN');
  });

  it('fails with no cash, or too little for one order', () => {
    const broke = { ...ready, balances: [{ currency: 'USD', available: D(0), hold: D(0) }] };
    expect(failures(broke)).toContain('USD to trade with');
    const tiny = {
      ...ready,
      config: { ...config, MIN_ORDER_NOTIONAL: 10 },
      balances: [{ currency: 'USD', available: D(5), hold: D(0) }],
    };
    expect(failures(tiny)).toContain('USD to trade with');
  });

  it('warns when the key sees far more cash than the caps allow', () => {
    const rich = { ...ready, balances: [{ currency: 'USD', available: D(20_000), hold: D(0) }] };
    expect(statusOf(rich, 'More cash than the caps allow')).toBe('WARN');
    expect(failures(rich)).toEqual([]);
  });

  it('warns about coins without a tested case', () => {
    const three = {
      ...ready,
      config: { ...config, PRODUCTS: ['BTC-USD', 'ETH-USD', 'SOL-USD'] },
      baseCurrencies: { 'BTC-USD': 'BTC', 'ETH-USD': 'ETH', 'SOL-USD': 'SOL' },
    };
    expect(statusOf(three, 'BTC only')).toBe('WARN');
  });
});

describe('trading fees', () => {
  const feeCheck = (feeTier: PreflightInput['feeTier']) =>
    evaluatePreflight({ ...ready, feeTier }).find((c) => c.title === 'Trading fees');

  it('passes a fee no higher than the one the backtests and the paper soak charged', () => {
    expect(feeCheck(ready.feeTier)?.status).toBe('PASS');
  });

  it('warns, with the round-trip cost, when the account pays more per market order', () => {
    const check = feeCheck({
      pricingTier: 'Intro 1',
      takerFeeRate: D('0.009'),
      makerFeeRate: D('0.005'),
      volume30dUsd: D(0),
    });
    expect(check?.status).toBe('WARN');
    expect(check?.detail).toContain('0.90% per market order and 0.50% per limit order');
    expect(check?.detail).toContain('(tier Intro 1, $0.00 traded in the last 30 days)');
    // (0.90% + 0.05% slippage) × 2 against (0.60% + 0.05%) × 2.
    expect(check?.detail).toContain('about 1.90% instead of 1.30%');
  });

  it('only warns: a higher fee is a cost to weigh, not a broken setup', () => {
    const pricey = {
      ...ready,
      feeTier: {
        pricingTier: 'Intro 1',
        takerFeeRate: D('0.012'),
        makerFeeRate: D('0.006'),
        volume30dUsd: D(0),
      },
    };
    expect(failures(pricey)).toEqual([]);
  });

  it('warns when Coinbase would not say', () => {
    const check = feeCheck({ error: 'HTTP 403 Forbidden' });
    expect(check?.status).toBe('WARN');
    expect(check?.detail).toMatch(/403.*0\.60% per market order/);
  });

  it('says nothing about fees it never read', () => {
    expect(feeCheck(null)).toBeUndefined();
  });
});

describe('losing-streak breaker', () => {
  it('fails the default of 4 for the regime strategy, whose backtests lost 9 in a row', () => {
    const input = { ...ready, config: { ...config, MAX_CONSECUTIVE_LOSSES: 4 } };
    expect(failures(input)).toContain('Losing-streak breaker');
  });

  it('passes a limit above the longest tested streak', () => {
    expect(statusOf(ready, 'Losing-streak breaker')).toBe('PASS');
  });

  it("does not judge other strategies by the regime filter's streaks", () => {
    const other = {
      ...ready,
      config: { ...config, STRATEGY: 'ta-ensemble' as const, MAX_CONSECUTIVE_LOSSES: 4 },
    };
    expect(statusOf(other, 'Losing-streak breaker')).toBeUndefined();
  });
});

describe('firstBuyEstimate', () => {
  it('is the allocation share of cash when the caps are loose', () => {
    expect(
      firstBuyEstimate(
        { ...config, MAX_POSITION_NOTIONAL: 1e6, MAX_TOTAL_NOTIONAL: 1e6 },
        D(1000),
      ).toNumber(),
    ).toBe(990);
  });

  it('is the tightest cap when a cap binds', () => {
    expect(firstBuyEstimate(config, D(10_000)).toNumber()).toBe(500);
  });

  it('keeps the fee reserve even at 100% allocation', () => {
    const full = {
      ...config,
      REGIME_ALLOCATION_PCT: 100,
      MAX_POSITION_NOTIONAL: 1e6,
      MAX_TOTAL_NOTIONAL: 1e6,
    };
    expect(firstBuyEstimate(full, D(1000)).toNumber()).toBe(990);
  });
});
