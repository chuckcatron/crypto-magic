import { atr } from '../indicators';
import { D, Decimal } from '../money';
import { checkStops, exitFillPrice, openPosition, ratchetStop, type StopConfig } from '../position/stops';
import { DEFAULT_RISK_LIMITS, type RiskLimits } from '../risk/limits';
import { sizePosition } from '../risk/position-sizer';
import type { Candle, ProductSpec } from '../types/market';
import { GRANULARITY_SECONDS } from '../types/market';
import type { ExitReason, Position, Signal } from '../types/trading';
import type { Strategy } from '../strategy/types';
import { buyAndHold } from './benchmark';
import { computeMetrics } from './metrics';
import { DEFAULT_FEE_MODEL, type BacktestResult, type BacktestTrade, type EquityPoint, type FeeModel } from './types';

export interface BacktestOptions {
  readonly candles: Candle[];
  readonly strategy: Strategy;
  readonly product: ProductSpec;
  readonly stopConfig: StopConfig;
  readonly riskLimits?: RiskLimits;
  readonly feeModel?: FeeModel;
  readonly initialEquity?: number;
}

interface PendingOrder {
  readonly kind: 'ENTER' | 'EXIT';
  readonly signal: Signal;
}

/**
 * Event-driven backtester with deliberately unfavourable assumptions:
 *
 *   - A signal computed on bar i's close fills at bar i+1's **open**, never at
 *     the close that produced it. Same-bar fills are the single most common way
 *     a backtest invents returns that do not exist.
 *   - Every fill pays taker fees and adverse slippage.
 *   - When one bar touches both the stop and the target, the stop wins.
 *   - The same risk engine caps that run live also run here, so a backtest
 *     cannot take a position the live bot would refuse.
 *
 * If it still looks good after all that, it is worth paper trading.
 */
export function runBacktest(options: BacktestOptions): BacktestResult {
  const {
    candles,
    strategy,
    product,
    stopConfig,
    riskLimits = DEFAULT_RISK_LIMITS,
    feeModel = DEFAULT_FEE_MODEL,
    initialEquity = 1000,
  } = options;

  if (candles.length === 0) throw new Error('backtest requires at least one candle');
  assertAscending(candles);

  const barSeconds = GRANULARITY_SECONDS[candles[0]!.granularity];
  const atrSeries = atr(candles, stopConfig.atrPeriod);

  let cash = D(initialEquity);
  let position: Position | null = null;
  let positionOpenedIndex = 0;
  let entrySignal: Signal | null = null;
  let entryFees = D(0);
  let pending: PendingOrder | null = null;

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const rejections: { time: number; reason: string }[] = [];
  let peakEquity = initialEquity;
  let barsInPosition = 0;

  for (let i = strategy.warmupBars; i < candles.length; i++) {
    const bar = candles[i]!;
    const barClose = bar.openTime + barSeconds;

    // ---- 1. Fill whatever the previous bar decided, at this bar's open ----
    if (pending) {
      if (pending.kind === 'ENTER' && !position) {
        const atrValue = atrSeries[i - 1];
        if (atrValue !== undefined && atrValue > 0) {
          const fillPrice = applySlippage(bar.open, 'BUY', feeModel);
          const provisional = openPosition({
            productId: product.productId,
            baseSize: 1,
            entryPrice: fillPrice,
            atrValue,
            openedAt: bar.openTime,
            config: stopConfig,
          });
          // Leave room for the entry fee: an order sized to all available cash
          // would otherwise cost cash + fee and be refused.
          const spendable = cash.div(D(1).plus(D(feeModel.takerBps).div(10_000)));
          const sizing = sizePosition({
            equity: cash,
            availableQuote: spendable,
            entryPrice: fillPrice,
            stopPrice: provisional.stopPrice,
            openNotional: 0,
            product,
            limits: riskLimits,
            confidence: pending.signal.confidence,
          });

          if (sizing.rejected) {
            rejections.push({ time: bar.openTime, reason: sizing.rejected });
          } else {
            const cost = sizing.notional;
            const fee = cost.mul(feeModel.takerBps).div(10_000);
            if (cost.plus(fee).gt(cash)) {
              rejections.push({ time: bar.openTime, reason: 'insufficient cash after fees' });
            } else {
              cash = cash.minus(cost).minus(fee);
              position = { ...provisional, baseSize: sizing.baseSize };
              positionOpenedIndex = i;
              entrySignal = pending.signal;
              entryFees = fee;
            }
          }
        }
      } else if (pending.kind === 'EXIT' && position) {
        const fillPrice = applySlippage(bar.open, 'SELL', feeModel);
        ({ cash } = closeOut({
          position,
          fillPrice,
          exitTime: bar.openTime,
          reason: pending.signal.exitReason ?? 'signal',
          barsHeld: i - positionOpenedIndex,
          cash,
          feeModel,
          entryFees,
          entrySignal,
          trades,
        }));
        position = null;
        entrySignal = null;
        entryFees = D(0);
      }
      pending = null;
    }

    // ---- 2. Protective stops run intrabar, before any new decision ----
    if (position) {
      const reason = checkStops({
        position,
        low: bar.low,
        high: bar.high,
        barsHeld: i - positionOpenedIndex,
        config: stopConfig,
      });
      if (reason) {
        const raw = exitFillPrice(position, reason, bar.close);
        const fillPrice = applySlippage(raw.toNumber(), 'SELL', feeModel);
        ({ cash } = closeOut({
          position,
          fillPrice,
          exitTime: barClose,
          reason,
          barsHeld: i - positionOpenedIndex,
          cash,
          feeModel,
          entryFees,
          entrySignal,
          trades,
        }));
        position = null;
        entrySignal = null;
        entryFees = D(0);
      } else {
        // Ratchet on the close, not the high: we cannot know when in the bar the
        // high printed, so trailing from it would be lookahead.
        position = ratchetStop(position, bar.close, stopConfig);
      }
    }

    // ---- 3. Decide on the closed bar; the order fills next bar ----
    // Exactly the trailing window the live engine fetches — see lookbackBars.
    // Also turns an O(n²) loop into O(n · lookback).
    const signal = strategy.evaluate({
      candles: candles.slice(Math.max(0, i + 1 - strategy.lookbackBars), i + 1),
      position,
      now: barClose,
    });
    if (signal.action === 'ENTER_LONG' && !position) {
      pending = { kind: 'ENTER', signal };
    } else if (signal.action === 'EXIT_LONG' && position) {
      pending = { kind: 'EXIT', signal };
    }

    // ---- 4. Mark to market ----
    if (position) barsInPosition++;
    const positionValue = position ? position.baseSize.mul(bar.close) : D(0);
    const equity = cash.plus(positionValue).toNumber();
    peakEquity = Math.max(peakEquity, equity);
    equityCurve.push({
      time: barClose,
      equity: round2(equity),
      cash: round2(cash.toNumber()),
      positionValue: round2(positionValue.toNumber()),
      drawdownPct: peakEquity > 0 ? round2(((peakEquity - equity) / peakEquity) * 100) : 0,
    });
  }

  // Close anything still open at the last price so the result is comparable.
  if (position) {
    const last = candles.at(-1)!;
    const fillPrice = applySlippage(last.close, 'SELL', feeModel);
    ({ cash } = closeOut({
      position,
      fillPrice,
      exitTime: last.openTime + barSeconds,
      reason: 'manual',
      barsHeld: candles.length - 1 - positionOpenedIndex,
      cash,
      feeModel,
      entryFees,
      entrySignal,
      trades,
    }));
  }

  return {
    strategy: strategy.name,
    benchmark: buyAndHold({
      candles,
      startIndex: strategy.warmupBars,
      initialEquity,
      feeModel,
    }),
    productId: product.productId,
    startTime: candles[0]!.openTime,
    endTime: candles.at(-1)!.openTime + barSeconds,
    initialEquity,
    finalEquity: round2(cash.toNumber()),
    trades,
    equityCurve,
    rejections,
    metrics: computeMetrics({
      trades,
      equityCurve,
      initialEquity,
      barSeconds,
      barsInPosition,
      totalBars: Math.max(0, candles.length - strategy.warmupBars),
    }),
  };
}

function closeOut(args: {
  position: Position;
  fillPrice: number;
  exitTime: number;
  reason: ExitReason;
  barsHeld: number;
  cash: Decimal;
  feeModel: FeeModel;
  entryFees: Decimal;
  entrySignal: Signal | null;
  trades: BacktestTrade[];
}): { cash: Decimal } {
  const { position, feeModel } = args;
  const exitPrice = D(args.fillPrice);
  const proceeds = position.baseSize.mul(exitPrice);
  const exitFee = proceeds.mul(feeModel.takerBps).div(10_000);
  const cash = args.cash.plus(proceeds).minus(exitFee);

  const costBasis = position.baseSize.mul(position.averageEntryPrice);
  const fees = args.entryFees.plus(exitFee);
  const pnl = proceeds.minus(costBasis).minus(fees);

  args.trades.push({
    productId: position.productId,
    entryTime: position.openedAt,
    exitTime: args.exitTime,
    entryPrice: position.averageEntryPrice,
    exitPrice,
    baseSize: position.baseSize,
    fees,
    pnl,
    pnlPct: costBasis.gt(0) ? pnl.div(costBasis).mul(100).toNumber() : 0,
    exitReason: args.reason,
    barsHeld: args.barsHeld,
    entryReasons: args.entrySignal?.reasons ?? [],
    confidence: args.entrySignal?.confidence ?? 0,
  });

  return { cash };
}

/** Slippage always moves against us: buys fill higher, sells fill lower. */
function applySlippage(price: number, side: 'BUY' | 'SELL', fees: FeeModel): number {
  const factor = fees.slippageBps / 10_000;
  return side === 'BUY' ? price * (1 + factor) : price * (1 - factor);
}

function assertAscending(candles: Candle[]): void {
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.openTime <= candles[i - 1]!.openTime) {
      throw new Error(
        `candles must be strictly ascending by openTime; index ${i} (${candles[i]!.openTime}) follows ${candles[i - 1]!.openTime}`,
      );
    }
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
