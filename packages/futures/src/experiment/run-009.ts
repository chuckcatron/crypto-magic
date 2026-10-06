/**
 * Runs EXPERIMENT-009 (docs/EXPERIMENT-009-any-crypto.md) on one window and
 * prints the results as Markdown.
 *
 *   pnpm --filter @crypto-magic/futures experiment-009 --window dev
 *   pnpm --filter @crypto-magic/futures experiment-009 --window holdout
 *
 * The holdout run reads data/exp009/dev.json for criterion 1 and prints the
 * verdict.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BINANCE_EXCLUDED,
  CANDIDATES,
  COINBASE_EXCLUDED,
  DailyMarket,
  between,
  btcRegime,
  equalWeightUniverse,
  holdBtc,
  matchedBtcAllocation,
  performance,
  returnsFromMarks,
  runPortfolio,
  type Bar,
  type Performance,
  type PortfolioStrategy,
} from '../index';
import { at, fingerprint, loadBars, pct } from './data';

type WindowName = 'dev' | 'holdout';
type UniverseName = 'B' | 'C';

const WINDOWS: Record<WindowName, { from: number; to: number; label: string }> = {
  dev: {
    from: at('2019-01-01'),
    to: at('2023-07-01'),
    label: 'Development, 2019-01-01 → 2023-07-01',
  },
  holdout: {
    from: at('2023-07-01'),
    to: at('2026-10-01'),
    label: 'Holdout, 2023-07-01 → 2026-10-01',
  },
};
const HALF = at('2025-02-15');
const MUGGLI = { from: at('2026-05-06'), to: at('2026-10-01') };
const COSTS = { base: 65, stress: 130, low: 15 } as const;
const UNIVERSES: Record<
  UniverseName,
  { dir: string; btc: string; expected: number; keep: (file: string) => boolean }
> = {
  B: {
    dir: 'binance-daily',
    btc: 'BTCUSDT',
    expected: 589,
    keep: (s) => s.endsWith('USDT') && !BINANCE_EXCLUDED.has(s),
  },
  C: {
    dir: 'coinbase-daily',
    btc: 'BTC-USD',
    expected: 393,
    keep: (s) => s.endsWith('-USD') && !COINBASE_EXCLUDED.has(s),
  },
};

interface Row {
  readonly id: string;
  readonly name: string;
  readonly cost: keyof typeof COSTS;
  readonly perf: Performance;
  readonly trades: number;
  readonly invested: number;
  readonly firstHalf: number;
  readonly secondHalf: number;
  readonly muggli: number | null;
  readonly yardstick: { fraction: number; annualized: number } | null;
  readonly beats: boolean | null;
}

interface WindowResult {
  readonly window: WindowName;
  readonly ranAt: string;
  readonly coins: Record<UniverseName, { loaded: number; skipped: string[] }>;
  readonly files: Record<string, string>;
  readonly rows: Record<UniverseName, Row[]>;
}

function argument(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const windowName = argument('window') as WindowName | undefined;
if (windowName !== 'dev' && windowName !== 'holdout') {
  console.error('usage: run-009.ts --window dev|holdout [--data <dir>]');
  process.exit(1);
}
const window = WINDOWS[windowName];
const dataDir = resolve(argument('data') ?? join(__dirname, '../../../../data'));
const outDir = join(dataDir, 'exp009');
mkdirSync(outDir, { recursive: true });

const files: Record<string, string> = {};
const coinsLoaded = {} as WindowResult['coins'];
const markets = {} as Record<UniverseName, DailyMarket>;
for (const [name, u] of Object.entries(UNIVERSES) as [
  UniverseName,
  (typeof UNIVERSES)[UniverseName],
][]) {
  const dir = join(dataDir, u.dir);
  const coins = new Map<string, Bar[]>();
  const skipped: string[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.csv'))
    .sort()) {
    const symbol = file.slice(0, -4);
    if (!u.keep(symbol)) continue;
    const path = join(dir, file);
    if (statSync(path).size === 0) {
      skipped.push(symbol);
      continue;
    }
    const bars = loadBars(path);
    if (bars.length === 0) {
      skipped.push(symbol);
      continue;
    }
    coins.set(symbol, bars);
    files[`${u.dir}/${file}`] = fingerprint(path);
  }
  if (coins.size + skipped.length !== u.expected) {
    console.error(
      `universe ${name}: ${coins.size} loaded + ${skipped.length} empty, protocol says ${u.expected}`,
    );
  }
  coinsLoaded[name] = { loaded: coins.size, skipped };
  markets[name] = new DailyMarket(coins);
}

function strategiesFor(btc: string): PortfolioStrategy[] {
  return [...CANDIDATES, holdBtc(btc), equalWeightUniverse, btcRegime(btc)];
}

function evaluate(name: UniverseName, cost: keyof typeof COSTS): Row[] {
  const u = UNIVERSES[name];
  const market = markets[name];
  return strategiesFor(u.btc).map((strategy) => {
    const started = Date.now();
    const run = runPortfolio({
      market,
      strategy,
      fillBps: COSTS[cost],
      btcSymbol: u.btc,
      from: window.from,
      to: window.to,
    });
    const returns = returnsFromMarks(run.daily, run.initialEquity);
    const perf = performance(returns);
    const total = (from: number, to: number) => performance(between(returns, from, to)).totalReturn;
    let yardstick: Row['yardstick'] = null;
    let beats: boolean | null = null;
    if (cost === 'base') {
      const matched = matchedBtcAllocation({
        market,
        btcSymbol: u.btc,
        targetDrawdown: perf.maxDrawdown,
        fillBps: COSTS.base,
        from: window.from,
        to: window.to,
      });
      yardstick = { fraction: matched.fraction, annualized: matched.performance.annualized };
      beats = perf.annualized > matched.performance.annualized;
    }
    console.error(`${name} ${cost} ${strategy.id}: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return {
      id: strategy.id,
      name: strategy.name,
      cost,
      perf,
      trades: run.trades.length,
      invested: run.averageInvested,
      firstHalf: total(window.from, HALF),
      secondHalf: total(HALF, window.to),
      muggli: windowName === 'holdout' ? total(MUGGLI.from, MUGGLI.to) : null,
      yardstick,
      beats,
    };
  });
}

const rows: WindowResult['rows'] = {
  B: [...evaluate('B', 'base'), ...evaluate('B', 'stress'), ...evaluate('B', 'low')],
  C: evaluate('C', 'base'),
};
const result: WindowResult = {
  window: windowName,
  ranAt: new Date().toISOString(),
  coins: coinsLoaded,
  files,
  rows,
};
writeFileSync(join(outDir, `${windowName}.json`), JSON.stringify(result, null, 2));

// ---- Report ----
const lines: string[] = [];
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${pct(Math.abs(x))}`;
const pick = (u: UniverseName, cost: keyof typeof COSTS, id: string) =>
  result.rows[u].find((r) => r.cost === cost && r.id === id)!;

lines.push(`### ${window.label}`, '');
lines.push(
  `Run ${result.ranAt}. Universe B: ${coinsLoaded.B.loaded} pairs with data` +
    `${coinsLoaded.B.skipped.length ? ` (${coinsLoaded.B.skipped.length} empty: ${coinsLoaded.B.skipped.join(', ')})` : ''}. ` +
    `Universe C: ${coinsLoaded.C.loaded} products with data` +
    `${coinsLoaded.C.skipped.length ? ` (${coinsLoaded.C.skipped.length} empty: ${coinsLoaded.C.skipped.join(', ')})` : ''}. ` +
    `File hashes are in \`data/exp009/${windowName}.json\`.`,
  '',
);
for (const u of ['B', 'C'] as const) {
  lines.push(
    `**Universe ${u}, base costs (65 bps a fill)**${u === 'B' ? ', with stress (130) and low-fee (15) returns alongside' : ''}:`,
    '',
  );
  lines.push(
    u === 'B'
      ? '| Strategy | Annualized | Total | Max drawdown | Trades | Invested | Same-drawdown BTC | Beats it? | At 130 bps | At 15 bps |'
      : '| Strategy | Annualized | Total | Max drawdown | Trades | Invested | Same-drawdown BTC | Beats it? |',
  );
  lines.push(
    u === 'B'
      ? '| -------- | ---------- | ----- | ------------ | ------ | -------- | ----------------- | --------- | ---------- | --------- |'
      : '| -------- | ---------- | ----- | ------------ | ------ | -------- | ----------------- | --------- |',
  );
  for (const r of result.rows[u].filter((x) => x.cost === 'base')) {
    const y = r.yardstick!;
    const cells = [
      r.id,
      signed(r.perf.annualized),
      signed(r.perf.totalReturn),
      `−${pct(r.perf.maxDrawdown)}`,
      String(r.trades),
      pct(r.invested, 0),
      `${pct(y.fraction, 0)} BTC: ${signed(y.annualized)}`,
      r.beats ? '**yes**' : 'no',
    ];
    if (u === 'B')
      cells.push(
        signed(pick('B', 'stress', r.id).perf.annualized),
        signed(pick('B', 'low', r.id).perf.annualized),
      );
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');
}

if (windowName === 'holdout') {
  lines.push(
    "**Holdout halves and Muggli's five months** (2026-05-06 → 2026-10-01), base costs, total return:",
    '',
  );
  lines.push(
    "| Strategy | B: 2023-07 → 2025-02-15 | B: 2025-02-15 → 2026-10 | B: Muggli's 5 months | C: Muggli's 5 months |",
  );
  lines.push(
    '| -------- | ----------------------- | ----------------------- | -------------------- | -------------------- |',
  );
  for (const r of result.rows.B.filter((x) => x.cost === 'base')) {
    lines.push(
      `| ${r.id} | ${signed(r.firstHalf)} | ${signed(r.secondHalf)} | ${signed(r.muggli!)} | ${signed(pick('C', 'base', r.id).muggli!)} |`,
    );
  }
  lines.push('');

  const devPath = join(outDir, 'dev.json');
  if (!existsSync(devPath)) throw new Error('run the development window first');
  const dev = JSON.parse(readFileSync(devPath, 'utf8')) as WindowResult;
  const devRow = (id: string) => dev.rows.B.find((r) => r.cost === 'base' && r.id === id)!;
  const ids = CANDIDATES.map((s) => s.id);
  lines.push('### Applying the decision rule', '');
  lines.push(`| Criterion | ${ids.join(' | ')} |`);
  lines.push(`| --------- | ${ids.map(() => '---').join(' | ')} |`);
  const verdict = new Map(ids.map((id) => [id, true]));
  const criteria: [string, (id: string) => [boolean, string]][] = [
    [
      '1. B development beats the yardstick',
      (id) => {
        const r = devRow(id);
        return [
          r.beats === true,
          `${signed(r.perf.annualized)} vs ${signed(r.yardstick!.annualized)}`,
        ];
      },
    ],
    [
      '2. B holdout beats the yardstick',
      (id) => {
        const r = pick('B', 'base', id);
        return [
          r.beats === true,
          `${signed(r.perf.annualized)} vs ${signed(r.yardstick!.annualized)}`,
        ];
      },
    ],
    [
      '3. B holdout positive in each half',
      (id) => {
        const r = pick('B', 'base', id);
        return [
          r.firstHalf > 0 && r.secondHalf > 0,
          `${signed(r.firstHalf)} / ${signed(r.secondHalf)}`,
        ];
      },
    ],
    [
      '4. B holdout > 0 at 130 bps',
      (id) => {
        const r = pick('B', 'stress', id);
        return [r.perf.annualized > 0, signed(r.perf.annualized)];
      },
    ],
    [
      '5. C holdout beats the yardstick',
      (id) => {
        const r = pick('C', 'base', id);
        return [
          r.beats === true,
          `${signed(r.perf.annualized)} vs ${signed(r.yardstick!.annualized)}`,
        ];
      },
    ],
  ];
  for (const [label, test] of criteria) {
    const cells = ids.map((id) => {
      const [pass, value] = test(id);
      if (!pass) verdict.set(id, false);
      return `${pass ? 'PASS' : '**FAIL**'} ${value}`;
    });
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  lines.push(
    `| **Verdict** | ${ids.map((id) => (verdict.get(id) ? '**PASS**' : '**FAIL**')).join(' | ')} |`,
  );
}
console.log(lines.join('\n'));
