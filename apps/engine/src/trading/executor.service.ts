import { Inject, Injectable } from '@nestjs/common';
import { D, type Decimal, type ExitReason, type OrderIntent, type Side } from '@crypto-magic/core';
import { ExchangeError, type ExchangeAdapter, type OrderResult } from '@crypto-magic/exchange';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import { childLogger } from '../common/logger';
import { KillSwitchService } from './kill-switch.service';
import { RiskService } from './risk.service';

const FILL_POLL_ATTEMPTS = 10;
const FILL_POLL_INTERVAL_MS = 1000;

export interface ExecutionResult {
  readonly submitted: boolean;
  readonly order: OrderResult | null;
  readonly skippedReason?: string;
}

/**
 * Turns an approved intent into an exchange order, exactly once.
 *
 * Every order carries a deterministic client order id derived from what the
 * order is FOR — mode, product, side, the bar that triggered it, and its
 * purpose — rather than from when it was sent. Two attempts to act on the same
 * bar therefore produce the same id, and the second one is refused locally
 * before it reaches the network. This is what makes a crash-and-restart
 * mid-order safe.
 */
@Injectable()
export class ExecutorService {
  private readonly log = childLogger('executor');

  constructor(
    @Inject(EXCHANGE) private readonly exchange: ExchangeAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly orders: OrderRepository,
    private readonly events: EventRepository,
    private readonly risk: RiskService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  /**
   * Deterministic, human-readable, and stable across restarts.
   *
   * `bar` is the open time of the candle that produced the decision, so a
   * restart that re-evaluates the same bar reproduces the same id. Stop exits
   * pass the current minute instead, since a stop can legitimately fire twice
   * within one bar after a partial fill.
   */
  static idempotencyKey(args: {
    mode: string;
    productId: string;
    side: Side;
    bar: number;
    purpose: string;
  }): string {
    const mode = args.mode === 'live' ? 'L' : 'P';
    const product = args.productId.replace(/[^A-Za-z0-9]/g, '');
    return `${mode}${args.side[0]}-${product}-${args.bar}-${args.purpose}`;
  }

  async execute(intent: OrderIntent): Promise<ExecutionResult> {
    const existing = this.orders.findByClientOrderId(intent.idempotencyKey);
    if (existing) {
      this.log.warn(
        { clientOrderId: intent.idempotencyKey, orderId: existing.orderId, status: existing.status },
        'refusing duplicate order: this idempotency key has already been submitted',
      );
      return { submitted: false, order: null, skippedReason: 'duplicate idempotency key' };
    }

    // Record the intent BEFORE reaching the network. If the process dies between
    // here and the exchange's response, the restart finds this row and refuses
    // to send the order a second time. A stranded PENDING row is recoverable;
    // a duplicated position is not.
    this.orders.save({
      orderId: `pending:${intent.idempotencyKey}`,
      clientOrderId: intent.idempotencyKey,
      productId: intent.productId,
      side: intent.side,
      status: 'PENDING',
      requestedBaseSize: intent.baseSize,
      filledSize: D(0),
      averageFillPrice: D(0),
      fee: D(0),
      referencePrice: intent.referencePrice,
      reason: intent.reason,
      exitReason: intent.exitReason ?? null,
      mode: this.config.TRADING_MODE,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    this.events.append({
      level: 'info',
      kind: 'order_submitted',
      message: `${intent.side} ${intent.baseSize.toFixed()} ${intent.productId}`,
      data: {
        reason: intent.reason,
        referencePrice: intent.referencePrice.toFixed(),
        live: this.exchange.isLive,
      },
    });

    let order: OrderResult;
    try {
      order = await this.exchange.submitMarketOrder({
        productId: intent.productId,
        side: intent.side,
        baseSize: intent.baseSize,
        referencePrice: intent.referencePrice,
        clientOrderId: intent.idempotencyKey,
      });
    } catch (error) {
      return this.handleSubmissionFailure(intent, error);
    }

    const settled = await this.awaitFill(order);
    this.persist(intent, settled);

    if (settled.status === 'FILLED' && settled.filledSize.gt(0)) {
      this.verifySlippage(intent, settled);
      this.events.append({
        level: 'info',
        kind: 'order_filled',
        message: `filled ${settled.filledSize.toFixed()} ${intent.productId} @ ${settled.averageFillPrice.toFixed()}`,
        data: { orderId: settled.orderId, fee: settled.fee.toFixed() },
      });
    } else {
      this.log.warn(
        { orderId: settled.orderId, status: settled.status, reject: settled.rejectReason },
        'order did not fill',
      );
      this.events.append({
        level: 'warn',
        kind: 'order_rejected',
        message: `order ${settled.orderId} ended ${settled.status}`,
        data: { rejectReason: settled.rejectReason },
      });
    }

    return { submitted: true, order: settled };
  }

  /**
   * A submission that throws is ambiguous: the order may or may not have
   * reached the exchange. We never retry it. Instead the local record is left
   * in place so the same key can never be resent, and the kill switch is
   * engaged so a human looks before the bot trades again.
   */
  private handleSubmissionFailure(intent: OrderIntent, error: unknown): ExecutionResult {
    const message = error instanceof Error ? error.message : String(error);
    const ambiguous = error instanceof ExchangeError && error.retryable;

    this.log.error(
      { err: message, clientOrderId: intent.idempotencyKey, ambiguous },
      'order submission failed',
    );
    this.events.append({
      level: 'error',
      kind: 'order_rejected',
      message: `submission failed for ${intent.productId}: ${message}`,
      data: { clientOrderId: intent.idempotencyKey, ambiguous },
    });

    if (ambiguous) {
      this.killSwitch.engage(
        `ambiguous order submission for ${intent.productId} (${intent.idempotencyKey}): ${message}. ` +
          'Check the exchange for an order that may have landed, then release the switch.',
      );
    }
    return { submitted: false, order: null, skippedReason: message };
  }

  /** A market IOC settles fast but not synchronously. Poll until it is terminal. */
  private async awaitFill(order: OrderResult): Promise<OrderResult> {
    if (isTerminal(order)) return order;

    let latest = order;
    for (let attempt = 0; attempt < FILL_POLL_ATTEMPTS; attempt++) {
      await sleep(FILL_POLL_INTERVAL_MS);
      try {
        const fetched = await this.exchange.getOrder(order.orderId);
        if (fetched) {
          latest = fetched;
          if (isTerminal(fetched)) return fetched;
        }
      } catch (error) {
        this.log.warn({ orderId: order.orderId, err: String(error) }, 'could not poll order status');
      }
    }

    this.log.error({ orderId: order.orderId, status: latest.status }, 'order never reached a terminal state');
    return latest;
  }

  /**
   * A fill far from the price we sized against means the book moved under us.
   * Halt rather than keep firing orders into a market we are mispricing.
   */
  private verifySlippage(intent: OrderIntent, order: OrderResult): void {
    const { ok, pct } = this.risk.checkSlippage(intent.referencePrice, order.averageFillPrice);
    if (ok) return;

    this.log.error(
      {
        productId: intent.productId,
        expected: intent.referencePrice.toFixed(),
        actual: order.averageFillPrice.toFixed(),
        slippagePct: pct,
      },
      'fill breached the slippage tolerance',
    );
    this.killSwitch.engage(
      `fill on ${intent.productId} slipped ${pct.toFixed(2)}% against a ${this.risk.limits.maxSlippagePct}% tolerance`,
    );
  }

  private persist(intent: OrderIntent, order: OrderResult): void {
    this.orders.save({
      orderId: order.orderId,
      clientOrderId: intent.idempotencyKey,
      productId: order.productId,
      side: order.side,
      status: order.status,
      requestedBaseSize: intent.baseSize,
      filledSize: order.filledSize,
      averageFillPrice: order.averageFillPrice,
      fee: order.fee,
      referencePrice: intent.referencePrice,
      reason: intent.reason,
      exitReason: intent.exitReason ?? null,
      mode: this.config.TRADING_MODE,
      createdAt: order.createdAt,
      updatedAt: Date.now(),
    });
  }
}

function isTerminal(order: OrderResult): boolean {
  return (
    order.status === 'FILLED' ||
    order.status === 'CANCELLED' ||
    order.status === 'EXPIRED' ||
    order.status === 'FAILED'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { Decimal, ExitReason };
