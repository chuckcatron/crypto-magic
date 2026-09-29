import { describe, expect, it } from 'vitest';
import { D } from '@crypto-magic/core';
import type { ExchangeAdapter } from '@crypto-magic/exchange';
import { loadConfig } from '../config/config.schema';
import { openDatabase } from '../persistence/database';
import { EventRepository } from '../persistence/repositories/event.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { severityForEvent } from '../alerts/severity';
import { KillSwitchService } from './kill-switch.service';
import { ReconciliationService } from './reconciliation.service';

const config = loadConfig({
  TRADING_MODE: 'paper',
  PRODUCTS: 'BTC-USD',
  DATABASE_PATH: ':memory:',
  KILL_SWITCH_FILE: `/tmp/cm-recon-kill-${process.pid}-${Math.random().toString(36).slice(2)}`,
  LOG_LEVEL: 'fatal',
});

/** An exchange that reports the given BTC balance, split into available and on-hold. */
function setup(btc: { available: string; hold: string }, withPosition = true) {
  const db = openDatabase(':memory:');
  const positions = new PositionRepository(db);
  const events = new EventRepository(db);
  const exchange = {
    getBalances: async () => [
      { currency: 'USD', available: D(4), hold: D(0) },
      { currency: 'BTC', available: D(btc.available), hold: D(btc.hold) },
    ],
    getProduct: async () => ({ productId: 'BTC-USD', baseCurrency: 'BTC' }),
  } as unknown as ExchangeAdapter;
  if (withPosition) {
    positions.upsert({
      productId: 'BTC-USD',
      baseSize: D('0.5'),
      averageEntryPrice: D(60000),
      openedAt: 1_700_000_000,
      stopPrice: D(40000),
      highWaterPrice: D(60000),
      takeProfitPrice: null,
      entryAtr: D(2000),
      barsHeld: 3,
      entryFee: D(1),
      protectiveStopOrderId: 'stop-1',
      entryReasons: [],
      confidence: 1,
      mode: 'live',
    });
  }
  const killSwitch = new KillSwitchService(config, events);
  const service = new ReconciliationService(exchange, config, positions, events, killSwitch);
  return { service, positions, events, killSwitch };
}

describe('ReconciliationService', () => {
  it('keeps a position whose coins are all on hold for its own exchange-side stop', async () => {
    // Live, with the protective stop resting: available reads 0, hold the whole size.
    const { service, positions, killSwitch } = setup({ available: '0', hold: '0.5' });
    const report = await service.reconcile();

    expect(report.removed).toEqual([]);
    expect(report.halted).toBe(false);
    expect(positions.findAll()).toHaveLength(1);
    expect(killSwitch.isEngaged()).toBe(false);
  });

  it('removes a position that is gone from the exchange, and says so in an alert', async () => {
    // E.g. the exchange-side stop filled while the engine was down.
    const { service, positions, events } = setup({ available: '0', hold: '0' });
    const report = await service.reconcile();

    expect(report.removed).toEqual(['BTC-USD']);
    expect(positions.findAll()).toHaveLength(0);
    const event = events.recent().find((e) => e.kind === 'reconciliation')!;
    expect(event.level).toBe('warn');
    expect(event.message).toMatch(/no longer held on the exchange/);
    expect(severityForEvent(event)).toBe('warning');
  });

  it('warns about coins held with no position record, and does not adopt them', async () => {
    const { service, positions, events } = setup({ available: '0.1', hold: '0' }, false);
    const report = await service.reconcile();

    expect(report.unmanagedBalances).toEqual(['BTC-USD']);
    expect(positions.findAll()).toHaveLength(0);
    expect(severityForEvent(events.recent().find((e) => e.kind === 'reconciliation')!)).toBe(
      'warning',
    );
  });

  it('stays quiet when everything matches', async () => {
    const { service, events } = setup({ available: '0.5', hold: '0' });
    await service.reconcile();
    const event = events.recent().find((e) => e.kind === 'reconciliation')!;
    expect(event.level).toBe('info');
    expect(severityForEvent(event)).toBeNull();
  });
});
