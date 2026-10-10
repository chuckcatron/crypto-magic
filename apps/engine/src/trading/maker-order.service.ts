import { Inject, Injectable } from '@nestjs/common';
import {
  D,
  floorToIncrement,
  type Decimal,
  type ExitReason,
  type OrderIntent,
} from '@crypto-magic/core';
import type { ExchangeAdapter, OrderResult, OrderStatus } from '@crypto-magic/exchange';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { MarketDataService } from '../market-data/market-data.service';
import { EventRepository } from '../persistence/repositories/event.repository';
import { OrderRepository } from '../persistence/repositories/order.repository';
import {
  WorkingOrderRepository,
  type WorkingOrder,
} from '../persistence/repositories/working-order.repository';
import { childLogger } from '../common/logger';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { RiskService } from './risk.service';

/** How long a maker order waits. Fixed by EXPERIMENT-011, not tuned, so not a setting. */
export const MAKER_WAIT_MS = 60 * 60_000;

/** A working order that has finished, with every leg that filled anything. */
export interface WorkingOutcome {
  readonly working: WorkingOrder;
  /** The maker order, the market order for the rest, or both. Empty if nothing filled. */
  readonly fills: OrderResult[];
}

/** What an entry needs, once filled, to become a position. */
export interface EntryContext {
  readonly atr: Decimal;
  readonly barOpenTime: number;
  readonly reasons: string[];
  readonly confidence: number;
}

const stillOpen = (status: OrderStatus) => status === 'OPEN' || status === 'PENDING';
const isOpen = (order: OrderResult) => stillOpen(order.status);

/**
 * EXPERIMENT-011's maker policy: post at the touch, wait, then cross.
 *
 * The strategy's own entries and signal exits are placed as post-only limits
 * at the best bid (to buy) or ask (to sell), and left for up to an hour. One
 * that fills pays the maker fee. Whatever has not filled by then is cancelled
 * and goes at market, as the order would have without this.
 *
 * A working order lives in the database from before it is sent until its fills
 * are booked, and every step re-reads the exchange, so a restart at any point
 * resumes it rather than repeating it. Each order keeps its own idempotency
 * key: the maker leg's and the market leg's are fixed when it is created.
 *
 * This service only moves orders. The engine books the fills it returns as a
 * position or a trade, and retires the working order in the same transaction.
 */
@Injectable()
export class MakerOrderService {
  private readonly log = childLogger('maker');

  constructor(
    @Inject(EXCHANGE) private readonly exchange: ExchangeAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly working: WorkingOrderRepository,
    private readonly orders: OrderRepository,
    private readonly events: EventRepository,
    private readonly executor: ExecutorService,
    private readonly risk: RiskService,
    private readonly marketData: MarketDataService,
    private readonly killSwitch: KillSwitchService,
  ) {}

  /** MAKER_ORDERS is on, and this exchange adapter can place maker orders. */
  get enabled(): boolean {
    return (
      this.config.MAKER_ORDERS &&
      this.exchange.submitMakerOrder !== undefined &&
      this.exchange.getBestBidAsk !== undefined
    );
  }

  list(): WorkingOrder[] {
    return this.working.findAll();
  }

  find(productId: string): WorkingOrder | null {
    return this.working.find(productId);
  }

  /** Stop tracking a finished working order. Synchronous, for the engine's transaction. */
  retire(productId: string): void {
    this.working.remove(productId);
  }

  /**
   * Put an approved intent on the book as a maker order.
   *
   * `posted`: it rests, and advance() finishes it. `refused`: nothing rests, so
   * the caller should go to market now. `blocked`: the kill switch is engaged or
   * the order was sent before; the caller must do nothing.
   */
  async post(args: {
    purpose: 'entry' | 'exit';
    intent: OrderIntent;
    entry?: EntryContext;
    exitReason?: ExitReason;
  }): Promise<'posted' | 'refused' | 'blocked'> {
    const { intent } = args;
    if (!this.exchange.getBestBidAsk) return 'refused';
    let limitPrice: Decimal;
    try {
      const book = await this.exchange.getBestBidAsk(intent.productId);
      limitPrice = intent.side === 'BUY' ? book.bid : book.ask;
    } catch (error) {
      this.log.warn(
        { productId: intent.productId, err: String(error) },
        'could not read the book to price a maker order; going to market',
      );
      return 'refused';
    }

    const now = Date.now();
    const makerKey = `${intent.idempotencyKey}-maker`;
    const working: WorkingOrder = {
      productId: intent.productId,
      purpose: args.purpose,
      side: intent.side,
      baseSize: intent.baseSize,
      referencePrice: intent.referencePrice,
      limitPrice,
      makerOrderId: `pending:${makerKey}`,
      makerClientOrderId: makerKey,
      crossClientOrderId: `${intent.idempotencyKey}-cross`,
      expiresAt: now + MAKER_WAIT_MS,
      reason: intent.reason,
      exitReason: args.exitReason ?? null,
      entryAtr: args.entry?.atr ?? null,
      barOpenTime: args.entry?.barOpenTime ?? Math.floor(now / 1000),
      entryReasons: args.entry?.reasons ?? [],
      confidence: args.entry?.confidence ?? 0,
      mode: this.config.TRADING_MODE,
      createdAt: now,
    };
    // Written before the order is sent, so no order can rest that nothing tracks.
    this.working.save(working);

    const result = await this.executor.postMaker(
      { ...intent, idempotencyKey: makerKey },
      limitPrice,
      working.expiresAt,
    );
    if (result.outcome === 'posted') {
      this.working.save({ ...working, makerOrderId: result.order.orderId });
      return 'posted';
    }
    if (result.outcome === 'refused') this.working.remove(intent.productId);
    // Blocked and possibly resting: kept, so advance() retires it once it has expired.
    return result.outcome;
  }

  /**
   * Take one step. Returns the outcome once the working order has finished:
   * its maker leg filled, or its time ran out (or the exchange ended it) and
   * the rest went at market. An entry is cut short, with nothing at market,
   * while the kill switch is engaged. Null while it is still waiting.
   */
  async advance(working: WorkingOrder): Promise<WorkingOutcome | null> {
    const makerId = this.makerIdOf(working);
    if (makerId === null) return this.retireUnconfirmed(working);

    const read = await this.read(working, makerId);
    if (read === null) return this.lost(working, makerId);
    let maker: OrderResult = read;

    const stopEntry = working.purpose === 'entry' && this.killSwitch.isEngaged();
    if (isOpen(maker) && Date.now() < working.expiresAt && !stopEntry) {
      this.executor.recordOrder(this.makerIntent(working), maker);
      return null;
    }
    if (isOpen(maker)) {
      const settled = await this.cancel(working, makerId, maker);
      if (settled === null) return null; // never go to market while it can still fill
      maker = settled;
    }
    this.recordFinal(working, maker);

    const fills = maker.filledSize.gt(0) ? [maker] : [];
    if (!stopEntry) {
      const rest = await this.cross(working, maker.filledSize);
      if (rest) fills.push(rest);
    }
    return { working, fills };
  }

  /**
   * End a working order now, with nothing at market: for a stop, the kill
   * switch or flattening. Returns what it filled, for the caller to book, or
   * null if the cancel is not confirmed yet.
   */
  async abort(working: WorkingOrder): Promise<WorkingOutcome | null> {
    const makerId = this.makerIdOf(working);
    if (makerId === null) return { working, fills: [] };

    let maker = await this.read(working, makerId);
    if (maker === null) return this.lost(working, makerId);
    if (isOpen(maker)) {
      const settled = await this.cancel(working, makerId, maker);
      if (settled === null) return null;
      maker = settled;
    }
    this.recordFinal(working, maker);
    return { working, fills: maker.filledSize.gt(0) ? [maker] : [] };
  }

  /** The exchange's id for the maker leg, or null if it was never acknowledged. */
  private makerIdOf(working: WorkingOrder): string | null {
    if (!working.makerOrderId.startsWith('pending:')) return working.makerOrderId;
    // The order may have been acknowledged just before a crash.
    const stored = this.orders.findByClientOrderId(working.makerClientOrderId);
    if (stored && !stored.orderId.startsWith('pending:')) {
      this.working.save({ ...working, makerOrderId: stored.orderId });
      return stored.orderId;
    }
    return null;
  }

  /**
   * The maker leg as the exchange reports it. Paper keeps resting orders in
   * memory, so after a restart it no longer knows one: it ended unfilled, or as
   * the database last saw it. Live, an unknown order is null.
   */
  private async read(working: WorkingOrder, makerId: string): Promise<OrderResult | null> {
    const order = await this.exchange.getOrder(makerId);
    if (order !== null || this.exchange.isLive) return order;
    const stored = this.orders.findByClientOrderId(working.makerClientOrderId);
    return {
      orderId: makerId,
      clientOrderId: working.makerClientOrderId,
      productId: working.productId,
      side: working.side,
      status: stored && !stillOpen(stored.status) ? stored.status : 'CANCELLED',
      filledSize: stored?.filledSize ?? D(0),
      averageFillPrice: stored?.averageFillPrice ?? D(0),
      fee: stored?.fee ?? D(0),
      createdAt: stored?.createdAt ?? working.createdAt,
    };
  }

  /** Cancel the maker leg and read it back. Null while the exchange still shows it open. */
  private async cancel(
    working: WorkingOrder,
    makerId: string,
    current: OrderResult,
  ): Promise<OrderResult | null> {
    try {
      await this.exchange.cancelOrders([makerId]);
    } catch (error) {
      // Most often it filled or expired a moment ago; the read below says which.
      this.log.warn({ productId: working.productId, err: String(error) }, 'maker cancel refused');
    }
    const after = (await this.read(working, makerId)) ?? current;
    if (isOpen(after)) {
      this.log.warn(
        { productId: working.productId, orderId: makerId },
        'maker order still open after a cancel; checking again next pass',
      );
      return null;
    }
    return after;
  }

  /** Send the rest at market, under the usual risk checks, and its fill or null. */
  private async cross(working: WorkingOrder, makerFilled: Decimal): Promise<OrderResult | null> {
    // Sent before, then the process stopped: read that order, never send another.
    const sent = this.orders.findByClientOrderId(working.crossClientOrderId);
    if (sent) {
      if (sent.orderId.startsWith('pending:')) return null; // ambiguous; the kill switch is on
      const order = (await this.exchange.getOrder(sent.orderId)) ?? {
        orderId: sent.orderId,
        clientOrderId: sent.clientOrderId,
        productId: sent.productId,
        side: sent.side,
        status: sent.status,
        filledSize: sent.filledSize,
        averageFillPrice: sent.averageFillPrice,
        fee: sent.fee,
        createdAt: sent.createdAt,
      };
      return order.filledSize.gt(0) ? order : null;
    }

    const product = await this.marketData.getProduct(working.productId);
    const rest = floorToIncrement(working.baseSize.minus(makerFilled), product.baseIncrement);
    if (rest.lte(0)) return null;
    const price = D((await this.marketData.getTicker(working.productId)).price);
    if (rest.mul(price).lt(product.minMarketFunds)) {
      this.log.info(
        { productId: working.productId, rest: rest.toFixed() },
        'what is left of the maker order is below the minimum order size; not sending it',
      );
      return null;
    }

    const intent: OrderIntent = {
      productId: working.productId,
      side: working.side,
      baseSize: rest,
      referencePrice: price,
      reason: working.reason,
      ...(working.exitReason ? { exitReason: working.exitReason } : {}),
      idempotencyKey: working.crossClientOrderId,
    };
    const { decision } = await this.risk.assess(intent);
    if (!decision.approved) {
      this.events.append({
        level: 'info',
        kind: 'risk_rejected',
        message:
          `risk refused the market order for the rest of the ${working.productId} ${working.purpose}: ` +
          decision.rejections.join('; '),
      });
      return null;
    }
    const result = await this.executor.execute({
      ...intent,
      baseSize: decision.adjustedBaseSize ?? rest,
    });
    return result.order && result.order.filledSize.gt(0) ? result.order : null;
  }

  /** Record the maker leg's final state, and say if it filled anything. */
  private recordFinal(working: WorkingOrder, maker: OrderResult): void {
    this.executor.recordOrder(this.makerIntent(working), maker);
    if (maker.filledSize.gt(0)) {
      this.events.append({
        level: 'info',
        kind: 'order_filled',
        message:
          `maker filled ${maker.filledSize.toFixed()} of ${working.baseSize.toFixed()} ${working.productId} ` +
          `@ ${maker.averageFillPrice.toFixed()}`,
        data: { orderId: maker.orderId, fee: maker.fee.toFixed(), status: maker.status },
      });
    }
  }

  /**
   * A maker order the exchange never acknowledged: the kill switch was engaged
   * when it was sent. Once its expiry is past it cannot be resting, so stop
   * tracking it. Anything it filled shows at the next reconciliation.
   */
  private retireUnconfirmed(working: WorkingOrder): WorkingOutcome | null {
    if (Date.now() < working.expiresAt) return null;
    this.events.append({
      level: 'warn',
      kind: 'error',
      message:
        `the maker order for ${working.productId} was never confirmed and has expired by now. ` +
        'If it filled anything, the next restart reconciles it.',
    });
    return { working, fills: [] };
  }

  /** Live, and the exchange does not know the order: never guess with a market order. */
  private lost(working: WorkingOrder, makerId: string): WorkingOutcome {
    this.killSwitch.engage(
      `Coinbase cannot find maker order ${makerId} for ${working.productId}. ` +
        'Check the exchange for it, then release the switch.',
    );
    return { working, fills: [] };
  }

  private makerIntent(working: WorkingOrder): OrderIntent {
    return {
      productId: working.productId,
      side: working.side,
      baseSize: working.baseSize,
      referencePrice: working.referencePrice,
      reason: working.reason,
      ...(working.exitReason ? { exitReason: working.exitReason } : {}),
      idempotencyKey: working.makerClientOrderId,
    };
  }
}
