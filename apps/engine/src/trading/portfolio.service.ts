import { Inject, Injectable } from '@nestjs/common';
import { D, Decimal, type TradingMode } from '@crypto-magic/core';
import type { ExchangeAdapter } from '@crypto-magic/exchange';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { MarketDataService } from '../market-data/market-data.service';
import {
  PositionRepository,
  type StoredPosition,
} from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { childLogger } from '../common/logger';

export interface PortfolioSnapshot {
  /** All the quote currency, including what open orders hold, such as a resting maker buy. */
  readonly cash: Decimal;
  /** The part of `cash` free to spend. What sizing and the risk checks use. */
  readonly availableCash: Decimal;
  readonly positionValue: Decimal;
  readonly equity: Decimal;
  readonly positions: StoredPosition[];
  readonly mode: TradingMode;
}

@Injectable()
export class PortfolioService {
  private readonly log = childLogger('portfolio');

  constructor(
    @Inject(EXCHANGE) private readonly exchange: ExchangeAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly positions: PositionRepository,
    private readonly state: StateRepository,
    private readonly marketData: MarketDataService,
  ) {}

  get mode(): TradingMode {
    return this.config.TRADING_MODE;
  }

  async availableQuote(): Promise<Decimal> {
    return (await this.quote()).available;
  }

  private async quote(): Promise<{ available: Decimal; hold: Decimal }> {
    const balances = await this.exchange.getBalances();
    const quote = balances.find((b) => b.currency === this.config.QUOTE_CURRENCY);
    return { available: quote?.available ?? D(0), hold: quote?.hold ?? D(0) };
  }

  /**
   * Mark the book to market.
   *
   * Position value uses the live ticker, not the entry price: equity has to
   * reflect what the book is worth now, or the daily-loss breaker is measuring
   * the wrong thing. Cash counts what open orders hold: a resting maker buy
   * reserves nearly all of it for up to an hour, and it is still ours.
   */
  async snapshot(): Promise<PortfolioSnapshot> {
    const { available, hold } = await this.quote();
    const cash = available.plus(hold);
    const open = this.positions.findAll();

    let positionValue = D(0);
    for (const position of open) {
      try {
        const ticker = await this.marketData.getTicker(position.productId);
        positionValue = positionValue.plus(position.baseSize.mul(ticker.price));
      } catch (error) {
        // A price we cannot fetch is valued at cost rather than dropped, so a
        // transient market-data failure cannot make equity silently shrink.
        this.log.warn(
          { productId: position.productId, err: String(error) },
          'could not price position; valuing at cost',
        );
        positionValue = positionValue.plus(position.baseSize.mul(position.averageEntryPrice));
      }
    }

    return {
      cash,
      availableCash: available,
      positionValue,
      equity: cash.plus(positionValue),
      positions: open,
      mode: this.mode,
    };
  }

  async recordEquitySnapshot(): Promise<PortfolioSnapshot> {
    const snapshot = await this.snapshot();
    this.state.recordEquity({
      ts: Date.now(),
      equity: snapshot.equity,
      cash: snapshot.cash,
      positionValue: snapshot.positionValue,
      mode: snapshot.mode,
    });
    return snapshot;
  }
}
