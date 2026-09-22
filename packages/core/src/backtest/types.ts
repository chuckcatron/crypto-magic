import type { Decimal } from '../money';
import type { ExitReason } from '../types/trading';

export interface FeeModel {
  /** Taker fee in basis points. Coinbase Advanced starts at 60bps at low volume. */
  readonly takerBps: number;
  /** Adverse price move assumed on every fill, in basis points. */
  readonly slippageBps: number;
}

export const DEFAULT_FEE_MODEL: FeeModel = { takerBps: 60, slippageBps: 5 };

export interface BacktestTrade {
  readonly productId: string;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryPrice: Decimal;
  readonly exitPrice: Decimal;
  readonly baseSize: Decimal;
  readonly fees: Decimal;
  /** Net of fees and slippage. */
  readonly pnl: Decimal;
  readonly pnlPct: number;
  readonly exitReason: ExitReason;
  readonly barsHeld: number;
  readonly entryReasons: string[];
  readonly confidence: number;
}

export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
  readonly cash: number;
  readonly positionValue: number;
  readonly drawdownPct: number;
}

export interface BacktestResult {
  /** Buy-and-hold over the same window. The number the strategy has to beat. */
  readonly benchmark: import('./benchmark').Benchmark;
  readonly strategy: string;
  readonly productId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly initialEquity: number;
  readonly finalEquity: number;
  readonly trades: BacktestTrade[];
  readonly equityCurve: EquityPoint[];
  readonly metrics: BacktestMetrics;
  /** Entries the risk engine or sizer refused, with the reason. Often the most useful output. */
  readonly rejections: { time: number; reason: string }[];
}

export interface BacktestMetrics {
  readonly totalReturnPct: number;
  readonly annualizedReturnPct: number;
  readonly maxDrawdownPct: number;
  readonly sharpeRatio: number;
  readonly sortinoRatio: number;
  readonly winRate: number;
  readonly profitFactor: number;
  readonly expectancy: number;
  readonly totalTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly averageWin: number;
  readonly averageLoss: number;
  readonly largestWin: number;
  readonly largestLoss: number;
  readonly averageBarsHeld: number;
  /** Fraction of bars spent holding a position. */
  readonly exposurePct: number;
  readonly totalFees: number;
}
