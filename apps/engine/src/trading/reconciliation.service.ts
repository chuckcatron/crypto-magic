import { Inject, Injectable } from '@nestjs/common';
import { D } from '@crypto-magic/core';
import type { ExchangeAdapter } from '@crypto-magic/exchange';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EXCHANGE } from '../exchange/tokens';
import { EventRepository } from '../persistence/repositories/event.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { childLogger } from '../common/logger';
import { KillSwitchService } from './kill-switch.service';

/** Relative gap between recorded and actual holdings we treat as a real mismatch. */
const MATERIAL_DRIFT = 0.01;

export interface ReconciliationReport {
  readonly checked: number;
  readonly corrected: string[];
  readonly removed: string[];
  readonly unmanagedBalances: string[];
  readonly halted: boolean;
}

/**
 * Make local state agree with the exchange before trading resumes.
 *
 * The exchange is the source of truth about what we own. The local database is
 * only a record of what we *think* we own, and after a crash, a manual trade,
 * or a fill that landed while the process was down, the two can disagree. A bot
 * that trades on a stale belief about its own holdings will happily try to sell
 * coins it does not have.
 */
@Injectable()
export class ReconciliationService {
  private readonly log = childLogger('reconciliation');

  constructor(
    @Inject(EXCHANGE) private readonly exchange: ExchangeAdapter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly positions: PositionRepository,
    private readonly events: EventRepository,
    private readonly killSwitch: KillSwitchService,
  ) {}

  async reconcile(): Promise<ReconciliationReport> {
    const balances = await this.exchange.getBalances();
    const byCurrency = new Map(balances.map((b) => [b.currency.toUpperCase(), b]));

    const stored = this.positions.findAll();
    const corrected: string[] = [];
    const removed: string[] = [];
    let halted = false;

    for (const position of stored) {
      const product = await this.exchange.getProduct(position.productId);
      const held = byCurrency.get(product.baseCurrency.toUpperCase())?.available ?? D(0);

      if (held.lte(0)) {
        this.log.warn(
          { productId: position.productId, recorded: position.baseSize.toFixed() },
          'recorded position has no matching balance; it was closed outside the bot',
        );
        this.positions.remove(position.productId);
        removed.push(position.productId);
        continue;
      }

      const drift = held.minus(position.baseSize).abs().div(position.baseSize);
      if (drift.gt(MATERIAL_DRIFT)) {
        // Trust the exchange, always. Taking the smaller of the two is not safer:
        // believing we hold less than we do strands coins outside the stop logic.
        this.log.warn(
          { productId: position.productId, recorded: position.baseSize.toFixed(), actual: held.toFixed() },
          'position size disagrees with the exchange; adopting the exchange value',
        );
        this.positions.upsert({ ...position, baseSize: held });
        corrected.push(position.productId);
        halted = true;
      }
    }

    // Coins we hold with no position record. Never auto-adopt these: they may be
    // a long-term holding the operator never wanted the bot to touch.
    const unmanagedBalances: string[] = [];
    for (const productId of this.config.PRODUCTS) {
      if (stored.some((p) => p.productId === productId)) continue;
      const product = await this.exchange.getProduct(productId);
      const held = byCurrency.get(product.baseCurrency.toUpperCase())?.available ?? D(0);
      if (held.mul(D(1)).gt(0)) {
        const notional = held;
        this.log.warn(
          { productId, held: notional.toFixed() },
          'holding a balance with no position record; the bot will not manage or sell it',
        );
        unmanagedBalances.push(productId);
      }
    }

    if (halted) {
      this.killSwitch.engage(
        `reconciliation found position sizes disagreeing with the exchange: ${corrected.join(', ')}. ` +
          'Local records were corrected to match. Review, then release the switch.',
      );
    }

    const report: ReconciliationReport = {
      checked: stored.length,
      corrected,
      removed,
      unmanagedBalances,
      halted,
    };

    this.events.append({
      level: halted ? 'error' : 'info',
      kind: 'reconciliation',
      message: `reconciled ${stored.length} position(s)`,
      data: report,
    });
    this.log.info(report, 'reconciliation complete');
    return report;
  }
}
