/**
 * F4's universe, frozen on 2026-10-06 (EXPERIMENT-008): every crypto
 * perpetual-style future on Coinbase Derivatives with a Coinbase USD spot pair,
 * except PAXG (a gold token). Spot products, which supply the price history.
 */
export const ROTATION_UNIVERSE = [
  'AAVE-USD',
  'ADA-USD',
  'AVAX-USD',
  'BCH-USD',
  'BNB-USD',
  'BTC-USD',
  'DOGE-USD',
  'DOT-USD',
  'ENA-USD',
  'ETH-USD',
  'HBAR-USD',
  'HYPE-USD',
  'LINK-USD',
  'LTC-USD',
  'NEAR-USD',
  'ONDO-USD',
  'PEPE-USD',
  'SHIB-USD',
  'SOL-USD',
  'SUI-USD',
  'XLM-USD',
  'XRP-USD',
  'ZEC-USD',
] as const;

/**
 * The perpetual each spot product stands in for, with its contract size as
 * Coinbase's public API reported it on 2026-10-06. Not used by EXPERIMENT-008,
 * which sizes fractionally. PEPE and SHIB perpetuals are quoted per 1000 coins:
 * confirm their units before anything sizes real orders from this table.
 */
export const PERPETUALS: Readonly<
  Record<string, { readonly productId: string; readonly contractSize: number }>
> = {
  'BTC-USD': { productId: 'BIP-20DEC30-CDE', contractSize: 0.01 },
  'ETH-USD': { productId: 'ETP-20DEC30-CDE', contractSize: 0.1 },
  'SOL-USD': { productId: 'SLP-20DEC30-CDE', contractSize: 5 },
  'XRP-USD': { productId: 'XPP-20DEC30-CDE', contractSize: 500 },
  'ADA-USD': { productId: 'ADP-20DEC30-CDE', contractSize: 1000 },
  'ZEC-USD': { productId: 'ZEC-20DEC30-CDE', contractSize: 1 },
  'NEAR-USD': { productId: 'NER-20DEC30-CDE', contractSize: 500 },
  'SUI-USD': { productId: 'SUP-20DEC30-CDE', contractSize: 500 },
  'AVAX-USD': { productId: 'AVP-20DEC30-CDE', contractSize: 10 },
  'ONDO-USD': { productId: 'OND-20DEC30-CDE', contractSize: 1000 },
  'HYPE-USD': { productId: 'HYP-20DEC30-CDE', contractSize: 10 },
  'DOT-USD': { productId: 'POP-20DEC30-CDE', contractSize: 100 },
  'XLM-USD': { productId: 'XLP-20DEC30-CDE', contractSize: 5000 },
  'LTC-USD': { productId: 'LCP-20DEC30-CDE', contractSize: 5 },
  'HBAR-USD': { productId: 'HEP-20DEC30-CDE', contractSize: 5000 },
  'LINK-USD': { productId: 'LNP-20DEC30-CDE', contractSize: 50 },
  'ENA-USD': { productId: 'ENA-20DEC30-CDE', contractSize: 5000 },
  'DOGE-USD': { productId: 'DOP-20DEC30-CDE', contractSize: 5000 },
  'PEPE-USD': { productId: 'PEP-20DEC30-CDE', contractSize: 100_000 },
  'AAVE-USD': { productId: 'AVE-20DEC30-CDE', contractSize: 5 },
  'BCH-USD': { productId: 'BCP-20DEC30-CDE', contractSize: 1 },
  'SHIB-USD': { productId: 'SHP-20DEC30-CDE', contractSize: 10_000 },
  'BNB-USD': { productId: 'BNB-20DEC30-CDE', contractSize: 1 },
};
