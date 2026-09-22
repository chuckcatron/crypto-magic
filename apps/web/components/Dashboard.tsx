'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  compactSize,
  engageKillSwitch,
  fetchDashboard,
  flattenAll,
  money,
  releaseKillSwitch,
  signedMoney,
  timeAgo,
  type DashboardData,
  type EventRow,
} from '@/lib/api';
import { EquityCurve } from './EquityCurve';
import { StatTile } from './StatTile';

const POLL_MS = 5000;

/**
 * Collapse runs of the same message into one row with a count.
 *
 * An engine that retries every 30 seconds writes the same failure hundreds of
 * times. Left uncollapsed it pushes everything else — the signals, the fills,
 * the reason a trade happened — off the panel entirely.
 */
function collapseRepeats(events: EventRow[]): (EventRow & { repeats: number })[] {
  const out: (EventRow & { repeats: number })[] = [];
  for (const event of events) {
    const previous = out[out.length - 1];
    if (previous && previous.kind === event.kind && previous.message === event.message) {
      previous.repeats++;
      continue;
    }
    out.push({ ...event, repeats: 1 });
  }
  return out;
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await fetchDashboard(signal));
      setError(null);
    } catch (cause) {
      if ((cause as Error).name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  const act = async (action: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <main className="shell">
        <h1 className="brand">crypto-magic</h1>
        {error ? (
          <p className="offline">
            Cannot reach the engine ({error}). Start it with <code>pnpm engine</code>.
          </p>
        ) : (
          <p className="empty">Loading…</p>
        )}
      </main>
    );
  }

  const { status, portfolio, positions, trades, events, equity, metrics } = data;
  const equityNow = Number.parseFloat(portfolio.equity);
  const startingEquity = equity.length > 0 ? Number.parseFloat(equity[0]!.equity) : null;
  const change = startingEquity !== null ? equityNow - startingEquity : null;
  const changePct = startingEquity ? (change! / startingEquity) * 100 : null;
  const realized = Number.parseFloat(metrics.realizedPnl);

  return (
    <main className="shell">
      <header className="header">
        <h1 className="brand">crypto-magic</h1>
        <span className={status.live ? 'badge badge--live' : 'badge badge--paper'}>
          {status.live ? '● LIVE — real money' : '○ paper'}
        </span>
        {/* Only worth a badge when it says something the mode badge did not. */}
        {status.exchange !== status.mode && <span className="badge">{status.exchange}</span>}
        <span className="badge">{status.strategy}</span>
        <span className="badge">{status.granularity}</span>
        {status.killSwitchEngaged && <span className="badge badge--halted">⛔ kill switch engaged</span>}
        <div className="header-spacer" />
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void act(
              status.killSwitchEngaged
                ? releaseKillSwitch
                : () => engageKillSwitch('engaged from the dashboard'),
              status.killSwitchEngaged
                ? 'Release the kill switch and allow new entries again?'
                : undefined,
            )
          }
        >
          {status.killSwitchEngaged ? 'Release kill switch' : 'Engage kill switch'}
        </button>
        <button
          className="btn btn--danger"
          disabled={busy || positions.length === 0}
          onClick={() =>
            void act(
              flattenAll,
              `Sell all ${positions.length} open position(s) at market, right now?`,
            )
          }
        >
          Flatten all
        </button>
      </header>

      {status.haltReasons.length > 0 && (
        <div className="banner">
          <strong>Entries halted:</strong> {status.haltReasons.join(', ')}. Exits still run
          normally.
        </div>
      )}
      {error && <div className="banner">Engine unreachable on the last poll: {error}</div>}

      <div className="tiles">
        <StatTile
          label="Account equity"
          hero
          value={money(portfolio.equity)}
          delta={
            change !== null
              ? {
                  text: `${signedMoney(change)} (${changePct!.toFixed(2)}%) since records began`,
                  direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
                }
              : undefined
          }
          sub={`${money(portfolio.cash)} cash · ${money(portfolio.positionValue)} in positions`}
        />
        <StatTile
          label="Realized P&L"
          value={signedMoney(metrics.realizedPnl)}
          delta={{
            text: `${money(metrics.totalFees)} paid in fees`,
            direction: realized > 0 ? 'up' : realized < 0 ? 'down' : 'flat',
          }}
        />
        <StatTile
          label="Open positions"
          value={`${positions.length} / ${status.limits.maxOpenPositions}`}
          sub={`cap ${money(status.limits.maxTotalNotional)} total · ${money(status.limits.maxPositionNotional)} each`}
        />
        <StatTile
          label="Closed trades"
          value={metrics.totalTrades}
          sub={
            metrics.totalTrades > 0
              ? `${metrics.winRate.toFixed(0)}% win rate (${metrics.winningTrades}W / ${metrics.losingTrades}L)`
              : 'no trades yet'
          }
        />
        <StatTile
          label="Market data"
          value={status.marketDataAgeSeconds === null ? '—' : `${status.marketDataAgeSeconds}s`}
          sub={`newest closed bar · ${status.products.join(', ')}`}
        />
      </div>

      <section className="card">
        <h2 className="card-title">Account equity</h2>
        <EquityCurve points={equity} startingEquity={startingEquity} />
      </section>

      <div className="grid-2">
        <section className="card">
          <h2 className="card-title">Open positions</h2>
          {positions.length === 0 ? (
            <p className="empty">Flat. Waiting for a signal.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Size</th>
                  <th className="num">Entry</th>
                  <th className="num">Stop</th>
                  <th className="num">Target</th>
                  <th className="num">Held</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.productId}>
                    <td className="strong">{p.productId}</td>
                    <td className="num">{compactSize(p.baseSize)}</td>
                    <td className="num">{money(p.averageEntryPrice)}</td>
                    <td className="num">{money(p.stopPrice)}</td>
                    <td className="num">{p.takeProfitPrice ? money(p.takeProfitPrice) : '—'}</td>
                    <td className="num">{p.barsHeld} bars</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">Recent trades</h2>
          {trades.length === 0 ? (
            <p className="empty">No closed trades yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Exit</th>
                  <th className="num">P&amp;L</th>
                  <th className="num">%</th>
                  <th className="num">Closed</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => {
                  const pnl = Number.parseFloat(t.pnl);
                  return (
                    <tr key={t.id}>
                      <td className="strong">{t.productId}</td>
                      <td>{t.exitReason.replace(/_/g, ' ')}</td>
                      {/* Sign and arrow carry direction; color only reinforces. */}
                      <td className={`num delta--${pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat'}`}>
                        <span aria-hidden="true">{pnl > 0 ? '▲ ' : pnl < 0 ? '▼ ' : ''}</span>
                        {signedMoney(t.pnl)}
                      </td>
                      <td className="num">{t.pnlPct.toFixed(2)}%</td>
                      <td className="num">{timeAgo(t.exitTime)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 className="card-title">Engine log</h2>
        {events.length === 0 ? (
          <p className="empty">Nothing logged yet.</p>
        ) : (
          <div className="events">
            {collapseRepeats(events).map((e) => (
              <div key={e.id} className={`event event--${e.level}`}>
                <span className="event-time">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="event-kind">{e.kind}</span>
                <span className="event-msg">{e.message}</span>
                {e.repeats > 1 && <span className="event-count">×{e.repeats}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
