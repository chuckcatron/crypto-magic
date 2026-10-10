import { D, Decimal, ALLOCATION_FEE_RESERVE_PCT, DEFAULT_FEE_MODEL } from '@crypto-magic/core';
import type { FeeTier, KeyPermissions } from '@crypto-magic/exchange';
import type { AppConfig } from '../config/config.schema';

/**
 * The checks behind `pnpm preflight`, run before the first live start.
 *
 * Pure: everything it needs is gathered first (live-preflight.ts), so every
 * rule here is unit-tested without a network or a Coinbase key.
 */

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface Check {
  readonly status: CheckStatus;
  readonly title: string;
  readonly detail: string;
}

export interface PreflightInput {
  readonly config: Pick<
    AppConfig,
    | 'TRADING_MODE'
    | 'PRODUCTS'
    | 'QUOTE_CURRENCY'
    | 'STRATEGY'
    | 'GRANULARITY'
    | 'REGIME_ALLOCATION_PCT'
    | 'MAX_TOTAL_NOTIONAL'
    | 'MAX_POSITION_NOTIONAL'
    | 'MIN_ORDER_NOTIONAL'
    | 'MAX_CONSECUTIVE_LOSSES'
    | 'PROTECTIVE_STOP_ENABLED'
    | 'HEARTBEAT_ENABLED'
    | 'DEADMAN_PING_URL'
    | 'DISCORD_WEBHOOK_URL'
    | 'TELEGRAM_BOT_TOKEN'
    | 'TELEGRAM_CHAT_ID'
    | 'NTFY_TOPIC'
    | 'COINBASE_API_KEY_NAME'
    | 'COINBASE_API_PRIVATE_KEY'
  >;
  /** From Coinbase, or the error that stopped us reading it. */
  readonly permissions: KeyPermissions | { error: string } | null;
  readonly balances:
    readonly { currency: string; available: Decimal; hold: Decimal }[] | { error: string } | null;
  /** The account's spot fee tier, the error that stopped us reading it, or null if not read. */
  readonly feeTier: FeeTier | { error: string } | null;
  /** Base currency per traded product, e.g. BTC-USD → BTC. */
  readonly baseCurrencies: Readonly<Record<string, string>>;
  readonly databaseExists: boolean;
  readonly databasePath: string;
  readonly env: { readonly privateToOwner: boolean | null; readonly gitIgnored: boolean | null };
}

/**
 * The longest losing streak the regime filter had in BTC backtests: 9 trades,
 * 2015-2021 (EXPERIMENT-001's development window). 5 in 2025-2026.
 */
export const LONGEST_TESTED_LOSING_STREAK = 9;

const failed = <T extends object>(x: T | { error: string } | null): x is { error: string } =>
  x !== null && 'error' in x;

/** What the first entry would spend, the way the sizer computes it for the regime strategy. */
export function firstBuyEstimate(
  config: PreflightInput['config'],
  quoteAvailable: Decimal,
): Decimal {
  const pct = config.STRATEGY === 'regime' ? config.REGIME_ALLOCATION_PCT : 100;
  return Decimal.min(
    quoteAvailable.mul(pct).div(100),
    D(config.MAX_POSITION_NOTIONAL),
    D(config.MAX_TOTAL_NOTIONAL),
    quoteAvailable.mul(100 - ALLOCATION_FEE_RESERVE_PCT).div(100),
  );
}

export function evaluatePreflight(input: PreflightInput): Check[] {
  const { config } = input;
  const checks: Check[] = [];
  const add = (status: CheckStatus, title: string, detail: string) =>
    checks.push({ status, title, detail });
  const usd = (n: Decimal | number) => `$${D(n).toFixed(2)}`;

  // --- The key ------------------------------------------------------------
  if (!config.COINBASE_API_KEY_NAME || !config.COINBASE_API_PRIVATE_KEY) {
    add(
      'FAIL',
      'API credentials',
      'COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY must both be set in .env.',
    );
  } else if (failed(input.permissions) || input.permissions === null) {
    add(
      'FAIL',
      'API credentials',
      `The key could not be used (check both values in .env; the private key must include its BEGIN/END lines): ${failed(input.permissions) ? input.permissions.error : 'not checked'}.`,
    );
  } else {
    const p = input.permissions;
    add(
      p.canView && p.canTrade ? 'PASS' : 'FAIL',
      'Key can view and trade',
      `view ${p.canView ? 'yes' : 'NO'}, trade ${p.canTrade ? 'yes' : 'NO'}.`,
    );
    add(
      p.canTransfer ? 'FAIL' : 'PASS',
      'Key cannot transfer or withdraw',
      p.canTransfer
        ? 'This key can move money off Coinbase. Delete it and create one with View and Trade only; a leaked .env would otherwise be able to empty the account.'
        : 'Transfers are off, so the worst a leaked key can do is trade.',
    );
    add(
      'PASS',
      'Portfolio',
      `The key belongs to portfolio ${p.portfolioUuid} (${p.portfolioType}).`,
    );
  }

  // --- The account -------------------------------------------------------------
  if (failed(input.balances)) {
    add('FAIL', 'Balances', `Could not read balances: ${input.balances.error}.`);
  } else if (input.balances !== null) {
    const held = (currency: string) =>
      input.balances === null || failed(input.balances)
        ? D(0)
        : input.balances
            .filter((b) => b.currency.toUpperCase() === currency.toUpperCase())
            .reduce((sum, b) => sum.plus(b.available).plus(b.hold), D(0));

    for (const productId of config.PRODUCTS) {
      const base = input.baseCurrencies[productId] ?? productId.split('-')[0]!;
      const amount = held(base);
      add(
        amount.gt(0) ? 'FAIL' : 'PASS',
        `No ${base} the bot did not buy`,
        amount.gt(0)
          ? `The portfolio already holds ${amount.toFixed()} ${base}. Once the bot opens its own ${base} position, startup reconciliation compares its record with the WHOLE ${base} balance and adopts all of it, and the next exit would sell your ${base} too. Move it to another portfolio first, or give the bot its own portfolio and key.`
          : `The portfolio holds no ${base}, so everything the bot later sees is its own.`,
      );
    }

    const cash = held(config.QUOTE_CURRENCY);
    const firstBuy = firstBuyEstimate(config, cash);
    if (cash.lte(0)) {
      add(
        'FAIL',
        `${config.QUOTE_CURRENCY} to trade with`,
        'The portfolio has no cash to buy with.',
      );
    } else if (firstBuy.lt(config.MIN_ORDER_NOTIONAL)) {
      add(
        'FAIL',
        `${config.QUOTE_CURRENCY} to trade with`,
        `The first buy would be ${usd(firstBuy)}, below MIN_ORDER_NOTIONAL (${usd(config.MIN_ORDER_NOTIONAL)}).`,
      );
    } else {
      add(
        'PASS',
        'First buy',
        `The portfolio has ${usd(cash)}. The first entry would spend about ${usd(firstBuy)} ` +
          `(${config.STRATEGY === 'regime' ? `${config.REGIME_ALLOCATION_PCT}% of equity, ` : ''}` +
          `capped at ${usd(config.MAX_POSITION_NOTIONAL)} per position and ${usd(config.MAX_TOTAL_NOTIONAL)} in total).`,
      );
    }
    if (cash.gt(D(config.MAX_TOTAL_NOTIONAL).mul(1.5))) {
      add(
        'WARN',
        'More cash than the caps allow',
        `The key can see ${usd(cash)} but the bot is capped at ${usd(config.MAX_TOTAL_NOTIONAL)}. The caps hold, but a portfolio holding only the bot's money makes that true by construction.`,
      );
    }
  }

  // --- Trading fees --------------------------------------------------------------
  // Coinbase sets the fee per account. Every backtest and the paper soak charged
  // DEFAULT_FEE_MODEL, so a higher real fee is a cost they never saw.
  const testedTaker = D(DEFAULT_FEE_MODEL.takerBps).div(10_000);
  const roundTrip = (taker: Decimal) =>
    taker.plus(D(DEFAULT_FEE_MODEL.slippageBps).div(10_000)).mul(2);
  const pct = (fraction: Decimal) => `${fraction.mul(100).toFixed(2)}%`;
  if (failed(input.feeTier)) {
    add(
      'WARN',
      'Trading fees',
      `Could not read the account's fee tier (${input.feeTier.error}). Look it up in Coinbase before going live: the backtests and the paper soak charged ${pct(testedTaker)} per market order.`,
    );
  } else if (input.feeTier !== null) {
    const fee = input.feeTier;
    const tier =
      `(${fee.pricingTier ? `tier ${fee.pricingTier}, ` : ''}` +
      `${usd(fee.volume30dUsd)} traded in the last 30 days)`;
    add(
      fee.takerFeeRate.lte(testedTaker) ? 'PASS' : 'WARN',
      'Trading fees',
      fee.takerFeeRate.lte(testedTaker)
        ? `Coinbase charges this account ${pct(fee.takerFeeRate)} per market order ${tier}, no more than the ${pct(testedTaker)} the backtests and the paper soak charged.`
        : `Coinbase charges this account ${pct(fee.takerFeeRate)} per market order and ${pct(fee.makerFeeRate)} per limit order that waits on the book ${tier}. ` +
            `The backtests and the paper soak charged ${pct(testedTaker)}, so a round trip costs about ${pct(roundTrip(fee.takerFeeRate))} instead of ${pct(roundTrip(testedTaker))} with slippage, ` +
            'and live results will trail paper by the difference on every trade.',
    );
  }

  // --- Local state ------------------------------------------------------------
  add(
    input.databaseExists ? 'FAIL' : 'PASS',
    'Fresh database',
    input.databaseExists
      ? `${input.databasePath} exists. Positions are not separated by mode, so paper positions would be treated as live ones. Archive it first (RUNBOOK: "Starting a fresh paper account"). Ignore this if you are already live.`
      : 'No database yet, so live starts with no paper history mixed in.',
  );

  // --- Strategy -----------------------------------------------------------------
  add(
    config.STRATEGY === 'regime' && config.GRANULARITY === 'ONE_DAY' ? 'PASS' : 'WARN',
    'Strategy as tested',
    `STRATEGY=${config.STRATEGY}, GRANULARITY=${config.GRANULARITY}. Only regime on ONE_DAY has a pre-registered pass (EXPERIMENT-001).`,
  );
  const untested = config.PRODUCTS.filter((p) => p !== 'BTC-USD');
  add(
    untested.length === 0 ? 'PASS' : 'WARN',
    'BTC only',
    untested.length === 0
      ? 'PRODUCTS=BTC-USD, the only coin with a tested case.'
      : `Also trading ${untested.join(', ')}. EXPERIMENT-003, 005 and 006 found no tested case beyond BTC.`,
  );
  if (config.STRATEGY === 'regime') {
    const limit = config.MAX_CONSECUTIVE_LOSSES;
    add(
      limit > LONGEST_TESTED_LOSING_STREAK ? 'PASS' : 'FAIL',
      'Losing-streak breaker',
      limit > LONGEST_TESTED_LOSING_STREAK
        ? `MAX_CONSECUTIVE_LOSSES=${limit}, above the ${LONGEST_TESTED_LOSING_STREAK} losses in a row BTC had in backtests.`
        : `MAX_CONSECUTIVE_LOSSES=${limit}. The regime filter lost ${LONGEST_TESTED_LOSING_STREAK} trades in a row on BTC in 2015-2021, and this halt does not clear by itself ` +
            '(only a win ends a streak, and a halted bot cannot trade), so the bot would sit halted partway through a losing run the backtests traded through, until you ran `cm reset-streak`. ' +
            `Set it to at least ${LONGEST_TESTED_LOSING_STREAK + 3}.`,
    );
  }
  add(
    config.PROTECTIVE_STOP_ENABLED ? 'PASS' : 'WARN',
    'Exchange-side stop',
    config.PROTECTIVE_STOP_ENABLED
      ? 'A stop-limit is placed on Coinbase at each entry, for when the engine is not running.'
      : 'PROTECTIVE_STOP_ENABLED=false: nothing protects a position while the engine is down.',
  );

  // --- Being told ------------------------------------------------------------------
  const channels = [
    config.NTFY_TOPIC && 'ntfy',
    config.DISCORD_WEBHOOK_URL && 'discord',
    config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID && 'telegram',
  ].filter(Boolean);
  add(
    channels.length > 0 ? 'PASS' : 'FAIL',
    'Alert channel',
    channels.length > 0
      ? `Alerts go to ${channels.join(', ')}.`
      : 'No alert channel. A halt, kill switch or reconciliation mismatch would go unnoticed.',
  );
  add(
    config.HEARTBEAT_ENABLED ? 'PASS' : 'WARN',
    'Daily check-in',
    config.HEARTBEAT_ENABLED
      ? 'On. Its absence is how you learn the bot died.'
      : 'HEARTBEAT_ENABLED=false: a dead bot looks like a quiet day.',
  );
  add(
    config.DEADMAN_PING_URL ? 'PASS' : 'WARN',
    "Dead man's switch",
    config.DEADMAN_PING_URL
      ? 'Configured: an outside service alerts you when the pings stop.'
      : 'Not configured. Only the missing daily check-in would tell you the bot stopped.',
  );

  // --- The .env file ------------------------------------------------------------------
  if (input.env.gitIgnored !== null) {
    add(
      input.env.gitIgnored ? 'PASS' : 'FAIL',
      '.env is git-ignored',
      input.env.gitIgnored
        ? 'git will not commit it.'
        : '.env is NOT ignored by git. A commit could publish your key.',
    );
  }
  if (input.env.privateToOwner !== null) {
    add(
      input.env.privateToOwner ? 'PASS' : 'WARN',
      '.env readable only by you',
      input.env.privateToOwner
        ? 'Permissions are owner-only.'
        : 'Other users on this Mac can read it. Run: chmod 600 .env',
    );
  }

  return checks;
}
