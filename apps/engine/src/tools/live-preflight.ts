/**
 * Read-only checks to run before the first live start.
 *
 *   pnpm preflight
 *
 * Uses the Coinbase key in .env to read the key's permissions, the balances
 * the bot would see, and the account's fee tier. It places no order and changes
 * nothing, in Coinbase or on disk. The adapter is held through a type that
 * exposes only read calls, so no code path here can reach an order method.
 *
 * Exits 1 if any check fails. See docs/GOING-LIVE.md.
 */
import '../config/load-env';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CoinbaseAdapter } from '@crypto-magic/exchange';
import { loadConfig } from '../config/config.schema';
import { REPO_ROOT } from '../config/paths';
import { evaluatePreflight, type PreflightInput } from './preflight';

type ReadOnlyAccount = Pick<
  CoinbaseAdapter,
  'getKeyPermissions' | 'getBalances' | 'getProduct' | 'getFeeTier'
>;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main(): Promise<void> {
  // Validated as paper so the live-only requirements do not stop a check that
  // is meant to run BEFORE live is armed. Every other setting is validated as usual.
  const config = loadConfig({ ...process.env, TRADING_MODE: 'paper' });

  let permissions: PreflightInput['permissions'] = null;
  let balances: PreflightInput['balances'] = null;
  let feeTier: PreflightInput['feeTier'] = null;
  const baseCurrencies: Record<string, string> = {};

  if (config.COINBASE_API_KEY_NAME && config.COINBASE_API_PRIVATE_KEY) {
    const account: ReadOnlyAccount = new CoinbaseAdapter({
      apiKey: config.COINBASE_API_KEY_NAME,
      apiSecret: config.COINBASE_API_PRIVATE_KEY,
    });
    try {
      permissions = await account.getKeyPermissions();
    } catch (error) {
      permissions = { error: message(error) };
    }
    if (!('error' in permissions)) {
      try {
        balances = await account.getBalances();
      } catch (error) {
        balances = { error: message(error) };
      }
      try {
        feeTier = await account.getFeeTier();
      } catch (error) {
        feeTier = { error: message(error) };
      }
      for (const productId of config.PRODUCTS) {
        try {
          baseCurrencies[productId] = (await account.getProduct(productId)).baseCurrency;
        } catch {
          // Falls back to the product id's prefix.
        }
      }
    }
  }

  const envPath = resolve(REPO_ROOT, '.env');
  let gitIgnored: boolean | null = null;
  try {
    execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: REPO_ROOT, stdio: 'ignore' });
    gitIgnored = true;
  } catch (error) {
    // Exit status 1 means "not ignored"; anything else (no git) is unknown.
    gitIgnored = (error as { status?: number }).status === 1 ? false : null;
  }

  const checks = evaluatePreflight({
    config,
    permissions,
    balances,
    feeTier,
    baseCurrencies,
    databaseExists: existsSync(config.DATABASE_PATH),
    databasePath: config.DATABASE_PATH,
    env: {
      privateToOwner: existsSync(envPath) ? (statSync(envPath).mode & 0o077) === 0 : null,
      gitIgnored,
    },
  });

  const mark = { PASS: '✔', WARN: '!', FAIL: '✘' } as const;
  process.stdout.write('\nLive preflight (read-only: nothing is ordered or changed)\n\n');
  for (const check of checks) {
    process.stdout.write(`  ${mark[check.status]} ${check.status}  ${check.title}\n`);
    process.stdout.write(`          ${check.detail}\n`);
  }
  const failures = checks.filter((c) => c.status === 'FAIL').length;
  const warnings = checks.filter((c) => c.status === 'WARN').length;
  process.stdout.write(
    `\n${failures === 0 ? 'READY' : 'NOT READY'}: ${failures} failed, ${warnings} warning(s).\n` +
      (failures === 0
        ? 'Next: docs/GOING-LIVE.md, step 5.\n'
        : 'Fix every FAIL before going live.\n'),
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`preflight could not run: ${message(error)}\n`);
  process.exitCode = 1;
});
