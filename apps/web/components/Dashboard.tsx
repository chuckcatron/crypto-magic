'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  compactSize,
  engageKillSwitch,
  fetchDashboard,
  flattenAll,
  money,
  releaseKillSwitch,
  sendTestAlert,
  signedMoney,
  timeAgo,
  VERDICT_DISPLAY,
  type DashboardData,
  type EventRow,
} from '@/lib/api';
import { EquityCurve } from './EquityCurve';
import { TradeReview } from './TradeReview';
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
  const [openTradeId, setOpenTradeId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

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

  const { status, portfolio, positions, trades, events, equity, metrics, insight, alerts } = data;
  const lastAlert = alerts.recent.at(-1);
  const alertsBroken =
    alerts.enabled && lastAlert !== undefined && lastAlert.results.every((r) => !r.ok);
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
        {insight.enabled && (
          <span className="badge" title={insight.lastError ?? 'local model writes trade reviews'}>
            ◆ {insight.model}
            {insight.pending > 0 ? ` · ${insight.pending} queued` : ''}
          </span>
        )}
        <span
          className={alerts.enabled ? (alertsBroken ? 'badge badge--halted' : 'badge') : 'badge badge--halted'}
          title={
            alerts.enabled
              ? `alerting via ${alerts.channels.join(', ')} · ${alerts.sent} sent, ${alerts.dropped} suppressed`
              : 'no alert channels configured — you will not be told if this stops'
          }
        >
          {alerts.enabled ? (alertsBroken ? '⚠ alerts failing' : `🔔 ${alerts.channels.join(', ')}`) : '🔕 no alerts'}
        </span>
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
          className="btn"
          disabled={busy || !alerts.enabled}
          title={alerts.enabled ? 'send a real alert to every channel' : 'no channels configured'}
          onClick={() =>
            void act(async () => {
              const delivery = await sendTestAlert();
              const ok = delivery.results.filter((r) => r.ok).map((r) => r.channel);
              const bad = delivery.results.filter((r) => !r.ok);
              setTestResult(
                bad.length === 0
                  ? `Test alert delivered to ${ok.join(', ')}.`
                  : `Delivered to ${ok.join(', ') || 'nothing'}. Failed: ${bad.map((b) => `${b.channel} (${b.error})`).join('; ')}`,
              );
            })
          }
        >
          Test alert
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
      {!alerts.enabled && (
        <div className="banner">
          <strong>No alert channels configured.</strong> If the bot halts itself while you are
          asleep, nothing will tell you. Set <code>NTFY_TOPIC</code>,{' '}
          <code>DISCORD_WEBHOOK_URL</code> or the Telegram pair in <code>.env</code>.
        </div>
      )}
      {alertsBroken && (
        <div className="banner">
          <strong>The last alert reached no channel.</strong>{' '}
          {lastAlert?.results.map((r) => r.error).filter(Boolean).join('; ')} — alerting is
          configured but not working, which is worse than knowing it is off.
        </div>
      )}
      {testResult && (
        <div className="banner" style={{ borderColor: 'var(--baseline)' }}>
          {testResult}{' '}
          <button className="btn" style={{ marginLeft: 8 }} onClick={() => setTestResult(null)}>
            Dismiss
          </button>
        </div>
      )}

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
          <h2 className="card-title">
            Recent trades{insight.enabled ? ' — click a row for the review' : ''}
          </h2>
          {trades.length === 0 ? (
            <p className="empty">No closed trades yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Exit</th>
                  {insight.enabled && <th>Review</th>}
                  <th className="num">P&amp;L</th>
                  <th className="num">%</th>
                  <th className="num">Closed</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => {
                  const pnl = Number.parseFloat(t.pnl);
                  const verdict = t.analysis ? VERDICT_DISPLAY[t.analysis.verdict] : null;
                  const isOpen = openTradeId === t.id;
                  return (
                    <Fragment key={t.id}>
                      <tr
                        className={`trade-row${isOpen ? ' trade-row--open' : ''}`}
                        onClick={() => setOpenTradeId(isOpen ? null : t.id)}
                      >
                        <td className="strong">{t.productId}</td>
                        <td>{t.exitReason.replace(/_/g, ' ')}</td>
                        {insight.enabled && (
                          <td>
                            {verdict ? (
                              <span className={`verdict verdict--${verdict.tone}`}>
                                <span aria-hidden="true">{verdict.tone === 'ok' ? '✓' : '⚠'}</span>
                                {verdict.process}
                              </span>
                            ) : (
                              <span className="verdict verdict--none">pending</span>
                            )}
                          </td>
                        )}
                        {/* Sign and arrow carry direction; color only reinforces. */}
                        <td className={`num delta--${pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat'}`}>
                          <span aria-hidden="true">{pnl > 0 ? '▲ ' : pnl < 0 ? '▼ ' : ''}</span>
                          {signedMoney(t.pnl)}
                        </td>
                        <td className="num">{t.pnlPct.toFixed(2)}%</td>
                        <td className="num">{timeAgo(t.exitTime)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={insight.enabled ? 6 : 5}>
                            <TradeReview analysis={t.analysis} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
