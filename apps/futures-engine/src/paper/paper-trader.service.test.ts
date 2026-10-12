import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bar } from '@crypto-magic/futures';
import type { Severity } from '@crypto-magic/notify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config';
import {
  GRANULARITY_SECONDS,
  type CandleGranularity,
  type CandleSource,
} from '../market/candle-source';
import type { Alerter } from './alerts';
import { PaperTraderService } from './paper-trader.service';
import { PaperStore } from './store';

/** Monday 2026-03-02 00:00 UTC. */
const START = Date.UTC(2026, 2, 2) / 1000;
const M5 = 300;
const DAY = 86_400;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A calm 5-minute random walk from `from` (inclusive) to `to` (exclusive). */
function calm(from: number, to: number, price: number, seed: number): Bar[] {
  const random = prng(seed);
  const bars: Bar[] = [];
  let p = price;
  for (let t = from; t < to; t += M5) {
    const open = p;
    p *= Math.exp((random() - 0.5) * 0.001);
    bars.push({
      t,
      o: open,
      h: Math.max(open, p) * 1.0002,
      l: Math.min(open, p) * 0.9998,
      c: p,
      v: 10,
    });
  }
  return bars;
}

class FakeCandles implements CandleSource {
  readonly m5 = new Map<string, Bar[]>();
  readonly daily = new Map<string, Bar[]>();
  fail = false;

  constructor(private readonly now: () => number) {}

  async fetch(
    productId: string,
    granularity: CandleGranularity,
    start: number,
    end: number,
  ): Promise<Bar[]> {
    if (this.fail) throw new Error('network down');
    const step = GRANULARITY_SECONDS[granularity];
    const source = (granularity === 'FIVE_MINUTE' ? this.m5 : this.daily).get(productId) ?? [];
    return source.filter((b) => b.t >= start && b.t < end && b.t + step <= this.now());
  }

  /** Continue a product's 5-minute bars with the given closes and volume. */
  extend(productId: string, closes: readonly number[], volume = 10): void {
    const bars = this.m5.get(productId)!;
    for (const close of closes) {
      const last = bars.at(-1)!;
      bars.push({
        t: last.t + M5,
        o: last.c,
        h: Math.max(last.c, close) * 1.0002,
        l: Math.min(last.c, close) * 0.9998,
        c: close,
        v: volume,
      });
    }
  }

  lastClose(productId: string): number {
    return this.m5.get(productId)!.at(-1)!.c;
  }
}

class RecordingAlerter implements Alerter {
  readonly sent: { severity: Severity; kind: string; title: string }[] = [];
  alert(severity: Severity, kind: string, title: string): void {
    this.sent.push({ severity, kind, title });
  }
}

describe('PaperTraderService', () => {
  let now = START + 20;
  let dir: string;
  let killSwitch: string;
  let candles: FakeCandles;
  let alerter: RecordingAlerter;
  let store: PaperStore;

  beforeEach(() => {
    now = START + 20;
    dir = mkdtempSync(join(tmpdir(), 'futures-paper-'));
    killSwitch = join(dir, 'FUTURES_KILL_SWITCH');
    candles = new FakeCandles(() => now);
    alerter = new RecordingAlerter();
    store = PaperStore.open(':memory:');
    const history = 55 * DAY;
    candles.m5.set('BTC-USD', calm(START - history, START, 60_000, 1));
    candles.m5.set('ETH-USD', calm(START - history, START, 3_000, 2));
    candles.m5.set('SOL-USD', calm(START - history, START, 150, 3));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function service(strategies = 'F1'): PaperTraderService {
    const config = loadConfig({
      FUTURES_STRATEGIES: strategies,
      FUTURES_DB_PATH: ':memory:',
      FUTURES_KILL_SWITCH_PATH: killSwitch,
    });
    return new PaperTraderService(config, candles, alerter, () => now, store);
  }

  /** Move the clock to just after the newest fake bar has closed. */
  function settle(): void {
    const newest = Math.max(...[...candles.m5.values()].map((bars) => bars.at(-1)!.t));
    now = newest + M5 + 20;
  }

  /** Every coin gets one more calm bar, BTC the given closes. */
  async function step(trader: PaperTraderService, btc: number[], volume = 10): Promise<void> {
    candles.extend('BTC-USD', btc, volume);
    for (const id of ['ETH-USD', 'SOL-USD']) {
      candles.extend(
        id,
        btc.map(() => candles.lastClose(id)),
      );
    }
    settle();
    await trader.tick();
  }

  const btc = (trader: PaperTraderService) =>
    trader.status().accounts.find((a) => a.id === 'F1:BTC-USD')!;

  it('warms up on history and trades nothing from before it started', async () => {
    const trader = service();
    await trader.start();
    const status = trader.status();
    expect(status.accounts.map((a) => a.id)).toEqual(['F1:BTC-USD', 'F1:ETH-USD', 'F1:SOL-USD']);
    for (const account of status.accounts) {
      expect(account.lastBar).toBe(new Date((START - M5) * 1000).toISOString());
      expect(account.equity).toBe(10_000);
      expect(account.trades).toBe(0);
    }
  });

  it('takes a paper trade from signal to target, and records it', async () => {
    const trader = service();
    await trader.start();
    const p = candles.lastClose('BTC-USD');
    // A 2% fall in 15 minutes, most of it in the last bar, on twenty times the usual volume.
    await step(trader, [p * 0.998, p * 0.996, p * 0.98], 200);
    expect(btc(trader).pendingEntry).toBe(true);

    await step(trader, [p * 0.981]);
    const position = btc(trader).position!;
    expect(position.direction).toBe('LONG');
    expect(position.entryPrice).toBeCloseTo(p * 0.98);
    expect(alerter.sent.some((a) => a.kind === 'opened')).toBe(true);
    // Marked at the close: 0.1% of p above the fill.
    expect(btc(trader).markPrice).toBeCloseTo(p * 0.981);
    expect(btc(trader).openPnl).toBeCloseTo(position.size * p * 0.001);

    // The target is half the 2% move back: entry + 1% of p.
    await step(trader, [p * 0.995]);
    const [trade] = store.recentTrades(10);
    expect(trade!.account_id).toBe('F1:BTC-USD');
    expect(trade!.exit_reason).toBe('target');
    expect(trade!.exit_price).toBeCloseTo(p * 0.99);
    expect(btc(trader).position).toBeNull();
    expect(btc(trader).openPnl).toBeNull();
    expect(btc(trader).equity).toBeGreaterThan(10_000);
    expect(btc(trader)).toMatchObject({ trades: 1, wins: 1, netPnl: trade!.net_pnl });
  });

  it('reports each strategy’s P&L from the start to now', async () => {
    const trader = service();
    await trader.start();
    const p = candles.lastClose('BTC-USD');
    await step(trader, [p * 0.998, p * 0.996, p * 0.98], 200);
    await step(trader, [p * 0.981]);
    await step(trader, [p * 0.995]);

    const history = trader.pnlHistory();
    expect(history.paperEquity).toBe(10_000);
    expect(history.strategies.map((s) => [s.strategy, s.accounts])).toEqual([['F1', 3]]);
    const points = history.strategies[0]!.points;
    expect(points[0]).toEqual({ t: trader.status().startedAt, pnl: 0 });
    const total = trader.status().accounts.reduce((sum, a) => sum + a.equity, 0);
    expect(points.at(-1)!.t).toBe(new Date(now * 1000).toISOString());
    expect(points.at(-1)!.pnl).toBeCloseTo(total - 30_000, 9);
    expect(points.at(-1)!.pnl).toBeGreaterThan(0);
  });

  it('resumes after a restart from its saved state, without duplicating trades', async () => {
    const first = service();
    await first.start();
    const p = candles.lastClose('BTC-USD');
    await step(first, [p * 0.998, p * 0.996, p * 0.98], 200);
    await step(first, [p * 0.981]);
    await step(first, [p * 0.995]);
    const equity = btc(first).equity;

    const second = service();
    await second.start();
    expect(btc(second).equity).toBeCloseTo(equity, 9);
    expect(store.recentTrades(10)).toHaveLength(1);
    await step(second, [p * 0.996]);
    expect(btc(second).lastBar).toBe(
      new Date(candles.m5.get('BTC-USD')!.at(-1)!.t * 1000).toISOString(),
    );
  });

  it('takes no new entry while the kill-switch file exists', async () => {
    const trader = service();
    await trader.start();
    writeFileSync(killSwitch, '');
    const p = candles.lastClose('BTC-USD');
    await step(trader, [p * 0.998, p * 0.996, p * 0.98], 200);
    await step(trader, [p * 0.981]);
    expect(btc(trader).pendingEntry).toBe(false);
    expect(btc(trader).position).toBeNull();
    expect(trader.status().killSwitch).toBe(true);
  });

  it('refuses decisions on bars it is only catching up on', async () => {
    const trader = service();
    await trader.start();
    const p = candles.lastClose('BTC-USD');
    // The same flush, but the engine only sees it two hours later.
    candles.extend('BTC-USD', [p * 0.998, p * 0.996, p * 0.98], 200);
    candles.extend('BTC-USD', new Array<number>(24).fill(p * 0.981));
    for (const id of ['ETH-USD', 'SOL-USD'])
      candles.extend(id, new Array<number>(27).fill(candles.lastClose(id)));
    settle();
    await trader.tick();
    expect(btc(trader).position).toBeNull();
    expect(btc(trader).pendingEntry).toBe(false);
    expect(btc(trader).lastBar).toBe(
      new Date(candles.m5.get('BTC-USD')!.at(-1)!.t * 1000).toISOString(),
    );
  });

  it('records a failed tick, alerts, and recovers on the next one', async () => {
    const trader = service();
    await trader.start();
    candles.fail = true;
    await step(trader, [candles.lastClose('BTC-USD')]);
    expect(trader.status().lastError).toBe('network down');
    expect(alerter.sent.some((a) => a.kind === 'tick_failed' && a.severity === 'warning')).toBe(
      true,
    );
    expect(store.recentEvents(5).some((e) => e.kind === 'tick_failed')).toBe(true);

    candles.fail = false;
    await trader.tick();
    expect(trader.status().lastError).toBeNull();
  });

  describe('F4 rotation', () => {
    const RATES: Record<string, number> = {
      'BTC-USD': 0.02,
      'ETH-USD': 0.015,
      'SOL-USD': 0.01,
      'XRP-USD': 0,
      'ADA-USD': -0.01,
      'DOGE-USD': -0.015,
      'LINK-USD': -0.02,
    };

    beforeEach(() => {
      for (const [productId, rate] of Object.entries(RATES)) {
        const bars: Bar[] = [];
        for (let n = 0; n < 70; n++) {
          const day = START - 60 * DAY + n * DAY;
          const open = 100 * (1 + rate) ** n;
          bars.push({
            t: day,
            o: open,
            h: open * 1.01,
            l: open * 0.99,
            c: open * (1 + rate),
            v: 1,
          });
        }
        candles.daily.set(productId, bars);
      }
    });

    it('rebalances on the first Monday after it starts, and keeps the book across a restart', async () => {
      const trader = service('F4');
      await trader.start();
      expect(trader.status().rotation!.positions).toHaveLength(0);

      // Monday START + 7 days has closed, and settled.
      now = START + 8 * DAY + 200;
      await trader.tick();
      const rotation = trader.status().rotation!;
      // Seven coins: two long, two short.
      expect(rotation.longs).toEqual(['BTC-USD', 'ETH-USD']);
      expect(rotation.shorts).toEqual(['DOGE-USD', 'LINK-USD']);
      expect(rotation.positions).toHaveLength(4);
      // Each holding is marked at its coin's latest daily close.
      const btcBar = candles.daily.get('BTC-USD')!.find((b) => b.t === START + 7 * DAY)!;
      const btcHolding = rotation.positions.find((h) => h.productId === 'BTC-USD')!;
      expect(btcHolding.markPrice).toBe(btcBar.c);
      expect(btcHolding.openPnl).toBeCloseTo(
        btcHolding.size * (btcBar.c - btcHolding.averageEntry),
        9,
      );
      expect(rotation).toMatchObject({ trades: 0, wins: 0, netPnl: 0 });

      const restarted = service('F4');
      await restarted.start();
      expect(restarted.status().rotation!.positions).toEqual(rotation.positions);
      expect(restarted.status().rotation!.equity).toBeCloseTo(rotation.equity, 9);
    });
  });
});
