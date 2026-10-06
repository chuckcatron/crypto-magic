/**
 * Runs EXPERIMENT-008 (docs/EXPERIMENT-008-fast-futures.md) on one window, at
 * base and stress costs, and prints the results as Markdown.
 *
 *   pnpm --filter @crypto-magic/futures experiment-008 --window dev
 *   pnpm --filter @crypto-magic/futures experiment-008 --window holdout
 *
 * The holdout run reads the development results (data/exp008/dev.json) for
 * criterion 1 and prints the verdict. Data comes from
 * scripts/fetch-coinbase-history.mjs, as the protocol lists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BASE_COSTS,
  INTRADAY_STRATEGIES,
  ROTATION_UNIVERSE,
  STRESS_COSTS,
  between,
  performance,
  poolReturns,
  returnsFromMarks,
  runIntraday,
  runRotation,
  tradeStats,
  type AccountRun,
  type Bar,
  type CostModel,
  type IntradayStrategyId,
  type Performance,
  type TradeStats,
} from '../index';
import { at, fingerprint, loadBars, pct } from './data';

type WindowName = 'dev' | 'holdout';
type StrategyId = IntradayStrategyId | 'F4';

const WINDOWS: Record<WindowName, { from: number; to: number; solFrom: number; label: string }> = {
  dev: {
    from: at('2019-01-01'),
    to: at('2023-07-01'),
    solFrom: at('2021-09-01'),
    label: 'Development, 2019-01-01 → 2023-07-01',
  },
  holdout: {
    from: at('2023-07-01'),
    to: at('2026-10-01'),
    solFrom: at('2023-07-01'),
    label: 'Holdout, 2023-07-01 → 2026-10-01',
  },
};
const HALF = at('2025-02-15');
const COINS = [
  { productId: 'BTC-USD', file: 'btc-5m.csv' },
  { productId: 'ETH-USD', file: 'eth-5m.csv' },
  { productId: 'SOL-USD', file: 'sol-5m.csv' },
] as const;
const INITIAL_EQUITY = 10_000;

interface AccountSummary {
  readonly label: string;
  readonly productId: string;
  readonly perf: Performance;
  readonly trades: TradeStats;
}

interface StrategyResult {
  readonly id: StrategyId;
  readonly pooled: Performance;
  readonly firstHalf: Performance;
  readonly secondHalf: Performance;
  readonly tradeCount: number;
  readonly accounts: readonly AccountSummary[];
}

interface WindowResult {
  readonly window: WindowName;
  readonly ranAt: string;
  readonly files: Record<string, string>;
  readonly base: readonly StrategyResult[];
  readonly stress: readonly StrategyResult[];
}

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const windowName = argument('window') as WindowName | undefined;
if (windowName !== 'dev' && windowName !== 'holdout') {
  console.error('usage: run-008.ts --window dev|holdout [--data <dir>]');
  process.exit(1);
}
const window = WINDOWS[windowName];
const dataDir = resolve(argument('data') ?? join(__dirname, '../../../../data'));
const outDir = join(dataDir, 'exp008');
mkdirSync(outDir, { recursive: true });

const files: Record<string, string> = {};
const fiveMinute = new Map<string, Bar[]>();
for (const coin of COINS) {
  const path = join(dataDir, coin.file);
  files[coin.file] = fingerprint(path);
  fiveMinute.set(coin.productId, loadBars(path));
}
const daily = new Map<string, Bar[]>();
for (const productId of ROTATION_UNIVERSE) {
  const path = join(dataDir, 'daily', `${productId}.csv`);
  files[`daily/${productId}.csv`] = fingerprint(path);
  daily.set(productId, loadBars(path));
}

function summarize(
  id: StrategyId,
  runs: readonly AccountRun[],
  productIds: readonly string[],
): StrategyResult {
  const returns = runs.map((run) => returnsFromMarks(run.daily, run.initialEquity));
  const pooled = poolReturns(returns);
  const accounts = runs.map((run, i) => ({
    label: run.label,
    productId: productIds[i]!,
    perf: performance(returns[i]!),
    trades: tradeStats(run.trades),
  }));
  return {
    id,
    pooled: performance(pooled),
    firstHalf: performance(between(pooled, window.from, HALF)),
    secondHalf: performance(between(pooled, HALF, window.to)),
    tradeCount: runs.reduce((n, run) => n + run.trades.length, 0),
    accounts,
  };
}

function runAll(costs: CostModel, label: string): StrategyResult[] {
  const results: StrategyResult[] = [];
  for (const id of ['F1', 'F2', 'F3'] as const) {
    const started = Date.now();
    const runs = COINS.map((coin) =>
      runIntraday({
        productId: coin.productId,
        bars: fiveMinute.get(coin.productId)!,
        strategy: INTRADAY_STRATEGIES[id],
        costs,
        from: coin.productId === 'SOL-USD' ? window.solFrom : window.from,
        to: window.to,
        initialEquity: INITIAL_EQUITY,
      }),
    );
    writeFileSync(
      join(outDir, `${windowName}-${label}-${id}-trades.json`),
      JSON.stringify(runs.map((r) => r.trades)),
    );
    results.push(
      summarize(
        id,
        runs,
        COINS.map((c) => c.productId),
      ),
    );
    console.error(`${label} ${id}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  const rotation = runRotation({
    bars: daily,
    costs,
    from: window.from,
    to: window.to,
    initialEquity: INITIAL_EQUITY,
  });
  writeFileSync(
    join(outDir, `${windowName}-${label}-F4-trades.json`),
    JSON.stringify(rotation.trades),
  );
  results.push(summarize('F4', [rotation], ['universe']));
  return results;
}

const result: WindowResult = {
  window: windowName,
  ranAt: new Date().toISOString(),
  files,
  base: runAll(BASE_COSTS, 'base'),
  stress: runAll(STRESS_COSTS, 'stress'),
};
writeFileSync(join(outDir, `${windowName}.json`), JSON.stringify(result, null, 2));

// ---- Report ----
const num = (x: number, digits = 2) => x.toFixed(digits);
const lines: string[] = [];
lines.push(`### ${window.label}`, '');
lines.push(`Run ${result.ranAt}. Input files (SHA-256, first 16):`, '');
for (const [file, hash] of Object.entries(files)) {
  if (!file.startsWith('daily/')) lines.push(`- \`${file}\` \`${hash}\``);
}
lines.push(
  `- \`daily/*.csv\` for the 23-coin universe: ${Object.keys(files).filter((f) => f.startsWith('daily/')).length} files, hashes in \`data/exp008/${windowName}.json\``,
);
lines.push('');
lines.push(
  'Pooled, base costs (8 bps a fill), with the stress-cost (16 bps) return alongside:',
  '',
);
lines.push(
  '| Strategy | Annualized | Total | t-stat | Max drawdown | Trades | Annualized at stress |',
);
lines.push(
  '| -------- | ---------- | ----- | ------ | ------------ | ------ | -------------------- |',
);
for (const r of result.base) {
  const stress = result.stress.find((s) => s.id === r.id)!;
  lines.push(
    `| ${r.id} | ${pct(r.pooled.annualized)} | ${pct(r.pooled.totalReturn)} | ${num(r.pooled.tStat)} | −${pct(r.pooled.maxDrawdown)} | ${r.tradeCount} | ${pct(stress.pooled.annualized)} |`,
  );
}
lines.push('');
lines.push(
  "Per coin, base costs. P&L columns are percent of the sub-account's starting equity:",
  '',
);
lines.push(
  '| Strategy | Coin | Annualized | Max drawdown | Trades | Win rate | Avg win | Avg loss | Long P&L | Short P&L | Fees + funding | Exits |',
);
lines.push(
  '| -------- | ---- | ---------- | ------------ | ------ | -------- | ------- | -------- | -------- | --------- | -------------- | ----- |',
);
for (const r of result.base) {
  for (const a of r.accounts) {
    const t = a.trades;
    const exits = Object.entries(t.exits)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    lines.push(
      `| ${r.id} | ${a.productId} | ${pct(a.perf.annualized)} | −${pct(a.perf.maxDrawdown)} | ${t.count} | ${pct(t.winRate, 1)} | ${pct(t.averageWin, 3)} | ${pct(t.averageLoss, 3)} | ${pct(t.long.netPnl / INITIAL_EQUITY)} | ${pct(t.short.netPnl / INITIAL_EQUITY)} | ${pct((t.fees + t.funding) / INITIAL_EQUITY)} | ${exits} |`,
    );
  }
}

if (windowName === 'holdout') {
  lines.push('', 'Holdout halves, pooled, base costs:', '');
  lines.push('| Strategy | 2023-07-01 → 2025-02-15 | 2025-02-15 → 2026-10-01 |');
  lines.push('| -------- | ----------------------- | ----------------------- |');
  for (const r of result.base)
    lines.push(`| ${r.id} | ${pct(r.firstHalf.totalReturn)} | ${pct(r.secondHalf.totalReturn)} |`);

  const devPath = join(outDir, 'dev.json');
  if (!existsSync(devPath)) throw new Error('run the development window first');
  const dev = JSON.parse(readFileSync(devPath, 'utf8')) as WindowResult;
  lines.push('', '### Applying the decision rule', '');
  lines.push('| Criterion | F1 | F2 | F3 | F4 |');
  lines.push('| --------- | -- | -- | -- | -- |');
  const ids: StrategyId[] = ['F1', 'F2', 'F3', 'F4'];
  const get = (set: readonly StrategyResult[], id: StrategyId) => set.find((r) => r.id === id)!;
  const checks: {
    name: string;
    test: (id: StrategyId) => { pass: boolean; value: string } | null;
  }[] = [
    {
      name: '1. Development annualized > 0',
      test: (id) => {
        const v = get(dev.base, id).pooled.annualized;
        return { pass: v > 0, value: pct(v) };
      },
    },
    {
      name: '2. Holdout annualized > 0',
      test: (id) => {
        const v = get(result.base, id).pooled.annualized;
        return { pass: v > 0, value: pct(v) };
      },
    },
    {
      name: '3. Holdout t-stat ≥ 2.5',
      test: (id) => {
        const v = get(result.base, id).pooled.tStat;
        return { pass: v >= 2.5, value: num(v) };
      },
    },
    {
      name: '4. Holdout annualized > 0 at stress costs',
      test: (id) => {
        const v = get(result.stress, id).pooled.annualized;
        return { pass: v > 0, value: pct(v) };
      },
    },
    {
      name: '5. Holdout > 0 in each half',
      test: (id) => {
        const r = get(result.base, id);
        return {
          pass: r.firstHalf.totalReturn > 0 && r.secondHalf.totalReturn > 0,
          value: `${pct(r.firstHalf.totalReturn)} / ${pct(r.secondHalf.totalReturn)}`,
        };
      },
    },
    {
      name: '6. Holdout trades ≥ 200',
      test: (id) => {
        const v = get(result.base, id).tradeCount;
        return { pass: v >= 200, value: String(v) };
      },
    },
    {
      name: '7. Holdout max drawdown ≤ 25%',
      test: (id) => {
        const v = get(result.base, id).pooled.maxDrawdown;
        return { pass: v <= 0.25, value: `−${pct(v)}` };
      },
    },
    {
      name: '8. Holdout > 0 on at least 2 of 3 coins',
      test: (id) => {
        if (id === 'F4') return null;
        const n = get(result.base, id).accounts.filter((a) => a.perf.totalReturn > 0).length;
        return { pass: n >= 2, value: `${n} of 3` };
      },
    },
  ];
  const verdicts = new Map<StrategyId, boolean>(ids.map((id) => [id, true]));
  for (const check of checks) {
    const cells = ids.map((id) => {
      const outcome = check.test(id);
      if (!outcome) return 'n/a';
      if (!outcome.pass) verdicts.set(id, false);
      return `${outcome.pass ? 'PASS' : '**FAIL**'} ${outcome.value}`;
    });
    lines.push(`| ${check.name} | ${cells.join(' | ')} |`);
  }
  lines.push(
    `| **Verdict** | ${ids.map((id) => (verdicts.get(id) ? '**PASS**' : '**FAIL**')).join(' | ')} |`,
  );
}
console.log(lines.join('\n'));
