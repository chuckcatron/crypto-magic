#!/usr/bin/env node
/**
 * List Coinbase USD spot products that meet EXPERIMENT-005's selection rule,
 * from PUBLIC endpoints. No API key.
 *
 *   node scripts/screen-coinbase-products.mjs --listed-by 2020-12-31 --exclude BTC,ETH,SOL
 *
 * Rule: quote currency USD; status online and not trading-disabled; not an
 * alias of another product; base currency not a stablecoin or a wrapped/staked
 * copy of another asset; not excluded; and at least one daily candle on or
 * before --listed-by. It checks only that a bar EXISTS: no price is read, so the
 * selection cannot depend on how a coin performed.
 *
 * Prints one product id per line on stdout; the reasoning goes to stderr.
 */

const API = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const DAY = 86_400;

/** Pegged to a currency, or a wrapped/staked copy of another asset. */
const NOT_A_MARKET = new Set([
  'USDT',
  'USDC',
  'DAI',
  'PYUSD',
  'GUSD',
  'USDP',
  'PAX',
  'BUSD',
  'TUSD',
  'EURC',
  'EUROC',
  'GYEN',
  'RLUSD',
  'USDS',
  'FDUSD',
  'LUSD',
  'SUSD',
  'MUSD',
  'UST',
  'WBTC',
  'CBBTC',
  'CBETH',
  'WETH',
  'MSOL',
  'JITOSOL',
  'LSETH',
  'WAXL',
  'WAMPL',
  'CGETH',
]);

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const listedBy = Date.parse(`${arg('listed-by') ?? '2020-12-31'}T00:00:00Z`) / 1000;
if (!Number.isFinite(listedBy)) {
  console.error('--listed-by must be a date like 2020-12-31');
  process.exit(1);
}
const excluded = new Set((arg('exclude') ?? '').toUpperCase().split(',').filter(Boolean));

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (response.ok) return response.json();
    if (attempt >= 5 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`${url} returned ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

const { products } = await get(`${API}?product_type=SPOT&limit=1000`);
const candidates = products.filter(
  (p) =>
    p.quote_currency_id === 'USD' &&
    p.status === 'online' &&
    !p.trading_disabled &&
    !p.is_disabled &&
    !p.alias_to?.length &&
    !NOT_A_MARKET.has(p.base_currency_id) &&
    !excluded.has(p.base_currency_id),
);
process.stderr.write(`${products.length} products, ${candidates.length} USD candidates\n`);

const selected = [];
for (const p of candidates) {
  // The last 300 days up to the cutoff: any bar at all means it was listed by then.
  const url = `${API}/${p.product_id}/candles?granularity=ONE_DAY&start=${listedBy - 299 * DAY}&end=${listedBy + DAY}&limit=300`;
  const { candles = [] } = await get(url);
  if (candles.some((c) => Number(c.start) <= listedBy)) selected.push(p.product_id);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

selected.sort();
process.stderr.write(`${selected.length} listed by ${arg('listed-by') ?? '2020-12-31'}\n`);
process.stdout.write(`${selected.join('\n')}\n`);
