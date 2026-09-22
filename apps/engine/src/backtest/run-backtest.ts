/**
 * Backtest runner.
 *
 *   pnpm backtest -- --product BTC-USD --days 365 --granularity ONE_HOUR
 *
 * Pulls real candles from Coinbase's PUBLIC endpoints, so it needs no API key,
 * and runs them through the same strategy, stop logic and risk caps the live
 * engine uses. Read the caveats it prints at the end before believing it.
 */
import '../config/load-env';
import { writeFileSync } from 'node:fs';
import {
  GRANULARITY_SECONDS,
  GRANULARITIES,
  TaEnsembleStrategy,
  runBacktest,
  type BacktestResult,
  type Granularity,
} from '@crypto-magic/core';
import { CoinbaseAdapter } from '@crypto-magic/exchange';
import { loadConfig } from '../config/config.schema';
import { toRiskLimits, toStopConfig, toStrategyConfig } from '../config/config.module';

interface Args {
  product: string;
  days: number;
  granularity: Granularity;
  equity: number;
  json: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(`--${flag}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const granularity = (get('granularity') ?? process.env.GRANULARITY ?? 'ONE_HOUR') as Granularity;
  if (!GRANULARITIES.includes(granularity)) {
    throw new Error(`unknown granularity "${granularity}"; expected one of ${GRANULARITIES.join(', ')}`);
  }

  const days = Number(get('days') ?? 365);
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');

  const equity = Number(get('equity') ?? 1000);
  if (!Number.isFinite(equity) || equity <= 0) throw new Error('--equity must be a positive number');

  return {
    product: (get('product') ?? process.env.PRODUCTS?.split(',')[0] ?? 'BTC-USD').toUpperCase(),
    days,
    granularity,
    equity,
    json: get('json') ?? null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ ...process.env, TRADING_MODE: 'paper' } as NodeJS.ProcessEnv);

  const strategy = new TaEnsembleStrategy(toStrategyConfig(config));
  const stopConfig = toStopConfig(config);
  const riskLimits = toRiskLimits(config);

  // Public market data: no credentials, and an adapter that cannot place orders.
  const exchange = new CoinbaseAdapter({});

  const step = GRANULARITY_SECONDS[args.granularity];
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.ceil(args.days * 86_400);
  const expectedBars = Math.ceil((end - start) / step);

  process.stderr.write(
    `Fetching ~${expectedBars} ${args.granularity} candles for ${args.product} (${args.days} days)...\n`,
  );

  const [product, candles] = await Promise.all([
    exchange.getProduct(args.product),
    exchange.getCandles({ productId: args.product, granularity: args.granularity, start, end }),
  ]);

  if (candles.length <= strategy.warmupBars) {
    throw new Error(
      `only ${candles.length} candles returned, but the strategy needs ${strategy.warmupBars} ` +
        'just to warm up. Ask for more days, or use a finer granularity.',
    );
  }

  const result = runBacktest({
    candles,
    strategy,
    product,
    stopConfig,
    riskLimits,
    initialEquity: args.equity,
  });

  report(result, candles.length, strategy.warmupBars);

  if (args.json) {
    writeFileSync(args.json, JSON.stringify(result, replacer, 2));
    process.stderr.write(`\nFull result written to ${args.json}\n`);
  }
}

function report(result: BacktestResult, bars: number, warmup: number): void {
  const m = result.metrics;
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const money = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;

  const lines = [
    '',
    '='.repeat(64),
    `  ${result.strategy}  ·  ${result.productId}`,
    `  ${new Date(result.startTime * 1000).toISOString().slice(0, 10)} → ${new Date(result.endTime * 1000).toISOString().slice(0, 10)}  (${bars} bars, ${warmup} used for warmup)`,
    '='.repeat(64),
    '',
    '  RETURN',
    `    Start / end equity      $${result.initialEquity.toFixed(2)} → $${result.finalEquity.toFixed(2)}`,
    `    Total return            ${pct(m.totalReturnPct)}`,
    `    Annualized              ${pct(m.annualizedReturnPct)}`,
    `    Max drawdown            -${m.maxDrawdownPct.toFixed(2)}%`,
    '',
    '  RISK-ADJUSTED',
    `    Sharpe                  ${m.sharpeRatio.toFixed(2)}`,
    `    Sortino                 ${m.sortinoRatio.toFixed(2)}`,
    `    Profit factor           ${m.profitFactor.toFixed(2)}`,
    `    Expectancy per trade    ${money(m.expectancy)}`,
    '',
    '  TRADES',
    `    Total                   ${m.totalTrades}  (${m.winningTrades}W / ${m.losingTrades}L)`,
    `    Win rate                ${m.winRate.toFixed(1)}%`,
    `    Average win / loss      ${money(m.averageWin)} / ${money(m.averageLoss)}`,
    `    Largest win / loss      ${money(m.largestWin)} / ${money(m.largestLoss)}`,
    `    Average bars held       ${m.averageBarsHeld.toFixed(1)}`,
    `    Time in market          ${m.exposurePct.toFixed(1)}%`,
    `    Fees paid               $${m.totalFees.toFixed(2)}`,
    '',
  ];

  if (m.totalTrades > 0) {
    const byReason = result.trades.reduce<Record<string, number>>((acc, t) => {
      acc[t.exitReason] = (acc[t.exitReason] ?? 0) + 1;
      return acc;
    }, {});
    lines.push('  EXITS');
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${reason.padEnd(22)}${count}`);
    }
    lines.push('');
  }

  if (result.rejections.length > 0) {
    const byReason = result.rejections.reduce<Record<string, number>>((acc, r) => {
      acc[r.reason] = (acc[r.reason] ?? 0) + 1;
      return acc;
    }, {});
    lines.push('  ENTRIES REFUSED BY RISK/SIZING');
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      lines.push(`    ${String(count).padStart(4)}  ${reason}`);
    }
    lines.push('');
  }

  lines.push(
    '  READ THIS BEFORE BELIEVING ANY OF THE ABOVE',
    '',
    '    - One product, one parameter set, one slice of history. A good result',
    '      here is evidence the code works, not evidence the edge is real.',
    `    - ${m.totalTrades} trades is ${m.totalTrades < 30 ? 'NOT enough to distinguish skill from luck' : 'a usable sample, but still not proof'}.`,
    '    - Fees and adverse slippage are modelled, but real fills in a fast',
    '      market are worse than modelled ones.',
    '    - Crypto spent most of the last decade going up. A long-only trend',
    '      follower will look good on that alone. Compare against buy-and-hold',
    '      over the same window before concluding anything.',
    '    - If you tune parameters until this number improves, you have fitted',
    '      the past, not found an edge. Change one thing at a time and check it',
    '      on a window you did not tune on.',
    '',
    '='.repeat(64),
    '',
  );

  process.stdout.write(lines.join('\n'));
}

/** Decimals serialize as strings; JSON numbers would reintroduce float error. */
function replacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && 'toFixed' in value && typeof value.toFixed === 'function') {
    return (value as { toFixed: () => string }).toFixed();
  }
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`\nBacktest failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
