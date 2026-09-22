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
  DEFAULT_FEE_MODEL,
  runBacktest,
  type BacktestResult,
  type Candle,
  type Granularity,
} from '@crypto-magic/core';
import { CoinbaseAdapter } from '@crypto-magic/exchange';
import { loadCsv } from './csv';
import { loadConfig } from '../config/config.schema';
import { toRiskLimits, toStopConfig, toStrategyConfig } from '../config/config.module';

interface Args {
  product: string;
  days: number;
  granularity: Granularity;
  equity: number;
  json: string | null;
  csv: string | null;
  split: boolean;
  takerBps: number;
  slippageBps: number;
  fullExposure: boolean;
  from: number | null;
  to: number | null;
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
    csv: get('csv') ?? null,
    split: argv.includes('--split'),
    // Lets you model a better fee tier, or set both to 0 to see how much of the
    // result is the strategy and how much is just the cost of trading.
    takerBps: numberFlag(get('taker-bps'), DEFAULT_FEE_MODEL.takerBps, 'taker-bps'),
    slippageBps: numberFlag(get('slippage-bps'), DEFAULT_FEE_MODEL.slippageBps, 'slippage-bps'),
    // Same capital as buy-and-hold, fully in or fully out. The only difference
    // from holding is WHEN — which is the question a timing signal must answer.
    fullExposure: argv.includes('--full-exposure'),
    from: dateFlag(get('from'), 'from'),
    to: dateFlag(get('to'), 'to'),
  };
}

function dateFlag(raw: string | undefined, name: string): number | null {
  if (raw === undefined) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`--${name} must be a date like 2017-01-01`);
  return Math.floor(ms / 1000);
}

function numberFlag(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ ...process.env, TRADING_MODE: 'paper' } as NodeJS.ProcessEnv);

  const strategy = new TaEnsembleStrategy(toStrategyConfig(config));
  const stopConfig = toStopConfig(config);
  let riskLimits = toRiskLimits(config);

  // Public market data: no credentials, and an adapter that cannot place orders.
  const exchange = new CoinbaseAdapter({});

  let product;
  let candles: Candle[];

  if (args.csv) {
    process.stderr.write(`Loading candles from ${args.csv}...\n`);
    candles = loadCsv(args.csv, args.product, args.granularity).filter(
      (c) =>
        (args.from === null || c.openTime >= args.from) &&
        (args.to === null || c.openTime < args.to),
    );
    product = {
      productId: args.product,
      baseCurrency: args.product.split('-')[0] ?? 'BTC',
      quoteCurrency: args.product.split('-')[1] ?? 'USD',
      baseIncrement: '0.00000001',
      quoteIncrement: '0.01',
      minMarketFunds: '1',
      tradingDisabled: false,
    };
  } else {
    // Public market data: no credentials, and an adapter that cannot place orders.
    const exchange = new CoinbaseAdapter({});
    const step = GRANULARITY_SECONDS[args.granularity];
    const end = Math.floor(Date.now() / 1000);
    const start = end - Math.ceil(args.days * 86_400);

    process.stderr.write(
      `Fetching ~${Math.ceil((end - start) / step)} ${args.granularity} candles for ${args.product} (${args.days} days)...\n`,
    );
    [product, candles] = await Promise.all([
      exchange.getProduct(args.product),
      exchange.getCandles({ productId: args.product, granularity: args.granularity, start, end }),
    ]);
  }

  if (candles.length <= strategy.warmupBars) {
    throw new Error(
      `only ${candles.length} candles available, but the strategy needs ${strategy.warmupBars} ` +
        'just to warm up. Ask for more days, use a finer granularity, or supply --csv.',
    );
  }

  const feeModel = { takerBps: args.takerBps, slippageBps: args.slippageBps };
  if (args.fullExposure) {
    // Lift every cap and let available cash bind, so each entry puts the whole
    // account in. This is a MEASUREMENT mode for comparing against buy-and-hold,
    // not a way to run the bot — never configure live trading like this.
    riskLimits = {
      ...riskLimits,
      maxPositionNotional: 1e12,
      maxTotalNotional: 1e12,
      riskPerTradePct: 100,
    };
    process.stderr.write('Full-exposure timing test: fully invested when in, flat when out.\n');
  }
  const run = (input: Candle[]) =>
    runBacktest({
      candles: input,
      strategy,
      product,
      stopConfig,
      riskLimits,
      feeModel,
      initialEquity: args.equity,
    });

  const result = run(candles);

  report(result, candles.length, strategy.warmupBars, {
    positionCap: riskLimits.maxPositionNotional,
    takerBps: args.takerBps,
    slippageBps: args.slippageBps,
  });

  if (args.split) {
    // Two halves, scored separately. An edge that exists in one half and
    // vanishes in the other is noise that happened to fit.
    const mid = Math.floor(candles.length / 2);
    const firstHalf = candles.slice(0, mid);
    const secondHalf = candles.slice(mid);

    if (firstHalf.length > strategy.warmupBars && secondHalf.length > strategy.warmupBars) {
      reportSplit(run(firstHalf), run(secondHalf));
    } else {
      process.stdout.write(
        `\n  Not enough history to split: each half needs more than ${strategy.warmupBars} bars.\n\n`,
      );
    }
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify(result, replacer, 2));
    process.stderr.write(`\nFull result written to ${args.json}\n`);
  }
}

const RULE = '='.repeat(68);
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const money = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
/** Magnitude only — for sentences that already say 'lost'. */
const mag = (v: number) => `${Math.abs(v).toFixed(2)}%`;

function report(
  result: BacktestResult,
  bars: number,
  warmup: number,
  costs: { positionCap: number; takerBps: number; slippageBps: number },
): void {
  const m = result.metrics;
  const b = result.benchmark;

  // The fixed cost of a round trip, independent of how well the strategy picks
  // entries. On a capped position this is frequently the whole story.
  const roundTripPct = ((costs.takerBps + costs.slippageBps) * 2) / 100;
  // Use the positions the backtest ACTUALLY took, not the configured cap: in
  // full-exposure mode the cap is a placeholder and dividing by it printed a
  // cost of thirteen billion dollars a trade.
  const averagePosition =
    result.trades.length > 0
      ? result.trades.reduce((sum, t) => sum + t.baseSize.mul(t.entryPrice).toNumber(), 0) /
        result.trades.length
      : costs.positionCap;
  const costPerTrade = (averagePosition * roundTripPct) / 100;
  const feeShareOfWin = m.averageWin > 0 ? (costPerTrade / m.averageWin) * 100 : Number.NaN;

  const lines = [
    '',
    RULE,
    `  ${result.strategy}  ·  ${result.productId}`,
    `  ${new Date(result.startTime * 1000).toISOString().slice(0, 10)} → ${new Date(result.endTime * 1000).toISOString().slice(0, 10)}  (${bars} bars, ${warmup} used for warmup)`,
    RULE,
    '',
    // The comparison goes FIRST. Everything below it is detail; this is the
    // decision. A strategy that loses to holding the asset is not a strategy.
    '  STRATEGY  vs  BUY & HOLD',
    '',
    `                          ${'strategy'.padStart(12)}   ${'buy & hold'.padStart(12)}`,
    `    Total return          ${pct(m.totalReturnPct).padStart(12)}   ${pct(b.totalReturnPct).padStart(12)}`,
    `    Annualized            ${pct(m.annualizedReturnPct).padStart(12)}   ${pct(b.annualizedReturnPct).padStart(12)}`,
    `    Max drawdown          ${`-${m.maxDrawdownPct.toFixed(2)}%`.padStart(12)}   ${`-${b.maxDrawdownPct.toFixed(2)}%`.padStart(12)}`,
    `    Sharpe                ${m.sharpeRatio.toFixed(2).padStart(12)}   ${b.sharpeRatio.toFixed(2).padStart(12)}`,
    `    Return / drawdown     ${mar(m.annualizedReturnPct, m.maxDrawdownPct).padStart(12)}   ${mar(b.annualizedReturnPct, b.maxDrawdownPct).padStart(12)}`,
    `    Time in market        ${`${m.exposurePct.toFixed(0)}%`.padStart(12)}   ${'100%'.padStart(12)}`,
    `    Capital deployed      ${`${m.capitalDeployedPct.toFixed(0)}%`.padStart(12)}   ${'100%'.padStart(12)}   (while in a trade)`,
    '',
    ...(m.capitalDeployedPct > 0 && m.capitalDeployedPct < 50
      ? [
          `  NOTE: the strategy puts only ${m.capitalDeployedPct.toFixed(0)}% of the account into a trade, buy & hold`,
          '  puts in all of it. Total return is NOT a fair comparison here — compare',
          '  Sharpe and return/drawdown, or re-run with --full-exposure for a',
          '  like-for-like timing test.',
          '',
        ]
      : []),
    ...verdict(m.totalReturnPct, m.maxDrawdownPct, b.totalReturnPct, b.maxDrawdownPct),
    '',
    '  STRATEGY DETAIL',
    `    Start / end equity      $${result.initialEquity.toFixed(2)} → $${result.finalEquity.toFixed(2)}`,
    `    Sortino                 ${m.sortinoRatio.toFixed(2)}`,
    `    Profit factor           ${m.profitFactor.toFixed(2)}`,
    `    Expectancy per trade    ${money(m.expectancy)}`,
    '',
    `    Trades                  ${m.totalTrades}  (${m.winningTrades}W / ${m.losingTrades}L, ${m.winRate.toFixed(1)}% win rate)`,
    `    Average win / loss      ${money(m.averageWin)} / ${money(m.averageLoss)}`,
    `    Largest win / loss      ${money(m.largestWin)} / ${money(m.largestLoss)}`,
    `    Average bars held       ${m.averageBarsHeld.toFixed(1)}`,
    '',
    '  COST OF TRADING',
    `    Round-trip cost         ${roundTripPct.toFixed(2)}% of position value  (${costs.takerBps}bps fee + ${costs.slippageBps}bps slippage, both ways)`,
    `    Break-even move         ${roundTripPct.toFixed(2)}% — every trade starts this far behind`,
    `    Cost per round trip     $${costPerTrade.toFixed(2)} on an average $${averagePosition.toFixed(2)} position`,
    Number.isFinite(feeShareOfWin)
      ? `    Versus average winner   ${feeShareOfWin.toFixed(0)}% of ${money(m.averageWin)}`
      : '    Versus average winner   n/a — no winning trades',
    `    Total fees              $${m.totalFees.toFixed(2)}  (${((m.totalFees / result.initialEquity) * 100).toFixed(1)}% of starting equity)`,
    ...(Number.isFinite(feeShareOfWin) && feeShareOfWin > 25
      ? [
          '',
          '    ⚠ Costs are eating a large share of every winner. At this position',
          '      size the fee tier matters more than the strategy does. Raising the',
          '      position cap, trading a slower granularity to cut turnover, or',
          '      reaching a lower fee tier will each move the needle more than any',
          '      parameter above.',
        ]
      : []),
    '',
  ];

  if (m.totalTrades > 0) {
    lines.push('  EXITS', ...tally(result.trades.map((t) => t.exitReason)), '');
  }
  if (result.rejections.length > 0) {
    lines.push(
      '  ENTRIES REFUSED BY RISK/SIZING',
      ...tally(result.rejections.map((r) => r.reason)).slice(0, 5),
      '',
    );
  }

  lines.push(
    '  READ THIS BEFORE BELIEVING ANY OF THE ABOVE',
    '',
    '    - One product, one parameter set, one slice of history. A good result',
    '      here is evidence the code works, not evidence the edge is real.',
    `    - ${m.totalTrades} trades is ${m.totalTrades < 30 ? 'NOT enough to distinguish skill from luck' : 'a usable sample, but still not proof'}.`,
    '    - Fees and adverse slippage are modelled, but real fills in a fast',
    '      market are worse than modelled ones.',
    '    - Run again with --split. An edge present in one half of the history',
    '      and absent in the other is noise that happened to fit.',
    '    - If you tune parameters until these numbers improve, you have fitted',
    '      the past. Change one thing at a time and re-check on data you did',
    '      not tune on.',
    '',
    RULE,
    '',
  );

  process.stdout.write(lines.join('\n'));
}

/**
 * The bottom line, stated plainly.
 *
 * Trend followers usually LOSE on raw return and WIN on drawdown, and that
 * trade is only worth taking if you would actually have held through the
 * alternative. Saying so explicitly matters more than the numbers above it.
 */
function verdict(
  stratReturn: number,
  stratDd: number,
  bhReturn: number,
  bhDd: number,
): string[] {
  const beatReturn = stratReturn > bhReturn;
  const lessPain = stratDd < bhDd;
  const gap = stratReturn - bhReturn;

  if (beatReturn && lessPain) {
    return [
      `  VERDICT: beat buy & hold on BOTH return (${pct(gap)}) and drawdown`,
      `  (${(bhDd - stratDd).toFixed(1)} points shallower). Worth paper trading.`,
    ];
  }
  if (beatReturn && !lessPain) {
    return [
      `  VERDICT: higher return (${pct(gap)}) but a DEEPER drawdown than holding.`,
      '  You are being paid for more risk, not less. Check you could sit through it.',
    ];
  }
  if (!beatReturn && lessPain) {
    return [
      `  VERDICT: lost ${mag(gap)} of return versus holding, in exchange for a`,
      `  drawdown ${(bhDd - stratDd).toFixed(1)} points shallower. That is the classic trend-following`,
      '  trade. It is only worth it if the deeper drawdown would have made you sell.',
    ];
  }
  return [
    `  VERDICT: LOST to buy & hold on both counts — ${mag(gap)} of return behind, and a`,
    `  ${(stratDd - bhDd).toFixed(1)} point deeper drawdown. On this data, holding the asset and`,
    '  doing nothing beat the bot. Do not fund this without changing something.',
  ];
}

/**
 * First half versus second half.
 *
 * The cheapest defence against fooling yourself. Parameters were chosen looking
 * at all of history; if the result only survives in the half that shaped them,
 * it is a fit rather than an edge.
 */
function reportSplit(first: BacktestResult, second: BacktestResult): void {
  const row = (label: string, a: string, b: string) =>
    `    ${label.padEnd(22)}${a.padStart(12)}   ${b.padStart(12)}`;

  const lines = [
    RULE,
    '  OUT-OF-SAMPLE SPLIT',
    RULE,
    '',
    `                          ${'1st half'.padStart(12)}   ${'2nd half'.padStart(12)}`,
    row('Strategy return', pct(first.metrics.totalReturnPct), pct(second.metrics.totalReturnPct)),
    row('Buy & hold return', pct(first.benchmark.totalReturnPct), pct(second.benchmark.totalReturnPct)),
    row(
      'Beat the benchmark?',
      first.metrics.totalReturnPct > first.benchmark.totalReturnPct ? 'yes' : 'no',
      second.metrics.totalReturnPct > second.benchmark.totalReturnPct ? 'yes' : 'no',
    ),
    row('Max drawdown', `-${first.metrics.maxDrawdownPct.toFixed(1)}%`, `-${second.metrics.maxDrawdownPct.toFixed(1)}%`),
    row('Trades', String(first.metrics.totalTrades), String(second.metrics.totalTrades)),
    row('Win rate', `${first.metrics.winRate.toFixed(0)}%`, `${second.metrics.winRate.toFixed(0)}%`),
    '',
    ...splitVerdict(first, second),
    '',
    RULE,
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

function splitVerdict(first: BacktestResult, second: BacktestResult): string[] {
  const beatFirst = first.metrics.totalReturnPct > first.benchmark.totalReturnPct;
  const beatSecond = second.metrics.totalReturnPct > second.benchmark.totalReturnPct;

  if (beatFirst && beatSecond) {
    return ['  Beat the benchmark in BOTH halves. That is the most encouraging thing', '  a backtest can tell you — though two halves is still a small sample.'];
  }
  if (!beatFirst && !beatSecond) {
    return ['  Lost to the benchmark in both halves. Consistent, at least. The strategy', '  as configured does not beat holding this asset.'];
  }
  return [
    '  Beat the benchmark in one half and not the other. That is what a fitted',
    '  parameter set looks like. Treat the full-period number as unreliable.',
  ];
}

function mar(annualized: number, drawdown: number): string {
  if (drawdown <= 0) return 'n/a';
  return (annualized / drawdown).toFixed(2);
}

function tally(values: string[]): string[] {
  const counts = values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `    ${String(count).padStart(5)}  ${name.replace(/_/g, ' ')}`);
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
