/*
 * The futures paper dashboard: polls this engine's read-only API and draws it.
 *
 * Plain DOM, no framework and no inline code, because the page's
 * Content-Security-Policy forbids it. Every string from the API goes in
 * through textContent, never as HTML.
 */
'use strict';

(() => {
  const POLL_MS = 15_000;
  const REQUEST_TIMEOUT_MS = 8_000;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const MINUS = '−';

  /** Plain-English names, in the chart's fixed color order (categorical slots 1-4). */
  const STRATEGIES = {
    F1: {
      name: 'Flush catcher',
      series: 1,
      holds: 'Up to 4 hours',
      blurb:
        'Watches for a sudden 15-minute crash or spike on very heavy volume, often forced selling, and bets on a partial snap-back.',
    },
    F2: {
      name: 'Squeeze breakout',
      series: 2,
      holds: 'Up to 24 hours',
      blurb:
        'Waits until a coin has gone unusually quiet, then follows the first strong breakout, up or down.',
    },
    F3: {
      name: 'Trend pullback',
      series: 3,
      holds: 'Up to 48 hours',
      blurb: 'Follows the 4-hour trend, joining it when a short dip against the trend ends.',
    },
    F4: {
      name: 'Weekly momentum',
      series: 4,
      holds: 'A week at a time',
      blurb:
        'Every Monday it bets on the coins that rose most over the last three weeks, and against those that fell most, across 23 coins.',
    },
  };
  const ORDER = ['F1', 'F2', 'F3', 'F4'];

  const EXIT_REASONS = {
    stop: 'Hit its stop-loss',
    target: 'Hit its profit target',
    time: 'Reached its time limit',
    rebalance: 'Weekly rebalance',
    end: 'Closed when the engine stopped',
  };

  /** The last good read of every endpoint, kept on screen while the engine is unreachable. */
  let snapshot = null;
  /** Why the last read failed, while it is failing. */
  let offline = null;
  let pollTimer = 0;
  let bannerKey = '';
  let chartWidth = 0;
  /** The time the chart's crosshair is on, so a refresh keeps it there. */
  let chartHover = null;
  /** Whether the reader opened the weekly momentum holdings, so a refresh keeps them open. */
  let holdingsOpen = false;

  // ---- DOM helpers -----------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  /** Build an element. `text` sets textContent; other props become attributes. */
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
    return node;
  }

  const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);

  // ---- Formatting ------------------------------------------------------------

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const usd0 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
  const priceFormats = {
    large: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    medium: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    // Sub-dollar coins run down to PEPE at ~$0.00001: keep four significant digits.
    small: new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 }),
  };
  const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayTime = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  const dayOnly = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const weekdayHour = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric' });
  const hourOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

  function money(value) {
    return usd.format(value);
  }

  /** "+$12.34", "−$5.00" or "$0.00". */
  function signedMoney(value) {
    const cents = Math.round(value * 100);
    if (cents === 0) return usd.format(0);
    return (cents > 0 ? '+' : MINUS) + usd.format(Math.abs(cents) / 100);
  }

  /** A fraction as a signed percentage: "+0.12%". */
  function signedPct(fraction, digits = 2) {
    const rounded = Number((fraction * 100).toFixed(digits));
    if (!Number.isFinite(rounded) || rounded === 0) return `${(0).toFixed(digits)}%`;
    return `${rounded > 0 ? '+' : MINUS}${Math.abs(rounded).toFixed(digits)}%`;
  }

  /** Prices from bitcoin to sub-cent coins, with the decimals each needs. */
  function price(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    const format =
      abs >= 1000 ? priceFormats.large : abs >= 1 ? priceFormats.medium : priceFormats.small;
    return `$${format.format(value)}`;
  }

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  /** "3:25 PM" today, otherwise "Tue 6 Oct, 3:25 PM", in this browser's time zone. */
  function when(ms) {
    const date = new Date(ms);
    return sameDay(date, new Date()) ? timeOnly.format(date) : dayTime.format(date);
  }

  function spell(seconds) {
    if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
    if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
    if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h`;
    const days = Math.round(seconds / 86400);
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  function ago(ms) {
    const seconds = (Date.now() - ms) / 1000;
    return seconds < 5 ? 'just now' : `${spell(seconds)} ago`;
  }

  function until(ms) {
    return `in ${spell(Math.max(0, (ms - Date.now()) / 1000))}`;
  }

  const coin = (productId) => String(productId).replace(/-USD$/, '');
  const sideName = (direction) => (direction === 'SHORT' ? 'Short' : 'Long');
  const strategyOf = (accountId) => String(accountId).split(':')[0];
  const nameOf = (id) => STRATEGIES[id]?.name ?? id;

  /** F4 rebalances at Monday 00:00 UTC: the next one strictly after `now`. */
  function nextMondayUtc(now) {
    const date = new Date(now);
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const ahead = (8 - date.getUTCDay()) % 7 || 7;
    return midnight + ahead * DAY;
  }

  /** P&L with its sign, an arrow and the up/down color, so color is never alone. */
  function pnlNode(value, text = signedMoney(value)) {
    const cents = Math.round(value * 100);
    const direction = cents > 0 ? 'up' : cents < 0 ? 'down' : 'flat';
    return el(
      'span',
      { class: `pnl ${direction}` },
      direction === 'flat'
        ? null
        : el('span', {
            class: 'arrow',
            'aria-hidden': 'true',
            text: direction === 'up' ? '▲' : '▼',
          }),
      text,
    );
  }

  // ---- Reading the API ---------------------------------------------------------

  async function getJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(path, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    clearTimeout(pollTimer);
    // Hold the previous numbers on screen, dimmed only if the read is slow.
    const slow = setTimeout(() => document.body.classList.add('is-loading'), 800);
    try {
      const [status, equity, trades, events] = await Promise.all([
        getJson('api/status'),
        getJson('api/equity'),
        getJson('api/trades?limit=50'),
        getJson('api/events?limit=30'),
      ]);
      snapshot = { status, equity, trades, events, at: Date.now() };
      offline = null;
      render();
    } catch (error) {
      offline = error instanceof Error ? error.message : String(error);
      renderConnection();
    } finally {
      clearTimeout(slow);
      document.body.classList.remove('is-loading');
      document.body.classList.toggle('is-offline', offline !== null && snapshot !== null);
      schedule();
    }
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (document.visibilityState === 'visible') pollTimer = setTimeout(refresh, POLL_MS);
  }

  // ---- Rendering -------------------------------------------------------------------

  function render() {
    const { status } = snapshot;
    const totals = totalsOf(status);
    renderConnection();
    renderHero(status, totals);
    renderKpis(status, totals);
    renderChart();
    renderStrategies(status);
    renderPositions(status);
    renderTrades(snapshot.trades);
    renderActivity(snapshot.events);
    $('footer-refreshed').textContent = `Last refreshed ${timeOnly.format(new Date(snapshot.at))}.`;
  }

  function totalsOf(status) {
    const paper = status.paperEquity || 10_000;
    const rotation = status.rotation;
    const books = status.accounts.length + (rotation ? 1 : 0);
    const equity = sum(status.accounts, (a) => a.equity) + (rotation ? rotation.equity : 0);
    const trades =
      sum(status.accounts, (a) => a.trades || 0) + (rotation ? rotation.trades || 0 : 0);
    const wins = sum(status.accounts, (a) => a.wins || 0) + (rotation ? rotation.wins || 0 : 0);
    const open =
      status.accounts.filter((a) => a.position).length + (rotation ? rotation.positions.length : 0);
    const openStrategies = new Set(
      status.accounts.filter((a) => a.position).map((a) => a.strategy),
    );
    if (rotation && rotation.positions.length) openStrategies.add('F4');
    const base = books * paper;
    return { paper, base, equity, pnl: equity - base, trades, wins, open, openStrategies };
  }

  function health() {
    const status = snapshot && snapshot.status;
    if (offline) return { level: 'critical', label: 'Offline', detail: 'can’t reach the engine' };
    if (!status) return { level: 'info', label: 'Connecting', detail: '' };
    if (status.lastError)
      return { level: 'critical', label: 'Problem', detail: 'last update failed' };
    if (!status.lastTickAt) return { level: 'info', label: 'Warming up', detail: 'loading prices' };
    const tick = Date.parse(status.lastTickAt);
    const age = (Date.now() - tick) / 1000;
    if (age > Math.max(120, 6 * (status.pollSeconds || 20))) {
      return { level: 'warning', label: 'Behind', detail: `no new prices for ${spell(age)}` };
    }
    return { level: 'good', label: 'Live', detail: `prices checked ${ago(tick)}` };
  }

  /** The status pill and the banners; also run every second to keep "ago" current. */
  function renderConnection() {
    const state = health();
    const pill = $('engine-status');
    pill.dataset.level = state.level;
    if ($('status-label').textContent !== state.label) $('status-label').textContent = state.label;
    $('status-detail').textContent = state.detail;
    renderBanners();
  }

  function renderBanners() {
    const status = snapshot && snapshot.status;
    const items = [];
    if (offline) {
      items.push({
        level: 'critical',
        title: 'Can’t reach the futures engine',
        text: snapshot
          ? `Showing the last numbers it sent, at ${when(snapshot.at)}. The engine may be stopped or restarting; as a service it restarts by itself within 30 seconds. This page keeps trying.`
          : 'It may be stopped or still starting. This page keeps trying every 15 seconds.',
      });
    } else if (status && status.lastError) {
      items.push({
        level: 'critical',
        title: 'The engine’s last update failed',
        text: `${status.lastError}. It tries again every ${status.pollSeconds || 20} seconds.`,
      });
    }
    if (status && status.killSwitch) {
      items.push({
        level: 'warning',
        title: 'New paper trades are paused',
        text: 'The kill-switch file data/FUTURES_KILL_SWITCH exists. Open positions still close normally. Delete the file to resume.',
      });
    }
    // Rebuild only on a change, so screen readers hear it once.
    const key = JSON.stringify(items.map((item) => [item.title, item.text]));
    if (key === bannerKey) return;
    bannerKey = key;
    $('banners').replaceChildren(
      ...items.map((item) =>
        el(
          'div',
          { class: 'banner', 'data-level': item.level },
          el('span', { class: 'level-icon', 'data-level': item.level, 'aria-hidden': 'true' }),
          el(
            'div',
            {},
            el('p', { class: 'banner-title', text: item.title }),
            el('p', { class: 'banner-text', text: item.text }),
          ),
        ),
      ),
    );
  }

  function renderHero(status, totals) {
    $('hero-value').replaceChildren(pnlNode(totals.pnl));
    // The engine trades from the first 5-minute mark after its first start.
    const started = Date.parse(status.startedAt);
    const since =
      started > Date.now()
        ? `trading starts at ${when(started)}`
        : `running since ${when(started)} (${spell((Date.now() - started) / 1000)})`;
    $('hero-sub').textContent =
      `${signedPct(totals.pnl / totals.base)} on ${usd0.format(totals.base)} of paper money · ${since}`;
    $('hero-summary').textContent = summary(status, totals);
  }

  function summary(status, totals) {
    if (!status.lastTickAt)
      return 'Loading recent prices. The numbers fill in within a minute or two.';
    const parts = [
      totals.open === 0
        ? 'No open positions right now.'
        : `${totals.open} open position${totals.open === 1 ? '' : 's'}.`,
      totals.trades === 0
        ? 'No trades have closed yet. Each strategy waits for its own setup, which can take hours.'
        : `${totals.trades} trade${totals.trades === 1 ? ' has' : 's have'} closed, ${totals.wins} at a profit.`,
    ];
    const rotation = status.rotation;
    if (rotation && rotation.positions.length === 0 && !rotation.trades) {
      const next = nextMondayUtc(Date.now());
      parts.push(
        `Weekly momentum makes its first trades ${until(next)}, on ${dayTime.format(new Date(next))} your time.`,
      );
    }
    return parts.join(' ');
  }

  function renderKpis(status, totals) {
    $('kpi-balance').textContent = money(totals.equity);
    $('kpi-balance-sub').textContent = `Started at ${usd0.format(totals.base)}`;
    $('kpi-trades').textContent = String(totals.trades);
    $('kpi-trades-sub').textContent = totals.trades
      ? `${totals.wins} won · ${totals.trades - totals.wins} lost`
      : 'None yet';
    $('kpi-winrate').textContent = totals.trades
      ? `${Math.round((totals.wins / totals.trades) * 100)}%`
      : '—';
    $('kpi-winrate-sub').textContent = totals.trades
      ? 'Of closed trades'
      : 'Shows after the first trade';
    $('kpi-open').textContent = String(totals.open);
    const strategies = totals.openStrategies.size;
    $('kpi-open-sub').textContent = totals.open
      ? `Across ${strategies} strateg${strategies === 1 ? 'y' : 'ies'}`
      : 'Waiting for setups';
  }

  // ---- Chart: P&L by strategy ----------------------------------------------------------

  function chartSeries() {
    return snapshot.equity.strategies
      .filter((s) => STRATEGIES[s.strategy])
      .sort((a, b) => ORDER.indexOf(a.strategy) - ORDER.indexOf(b.strategy))
      .map((s) => ({
        id: s.strategy,
        name: nameOf(s.strategy),
        series: STRATEGIES[s.strategy].series,
        points: s.points.map((p) => ({ t: Date.parse(p.t), v: p.pnl })),
      }));
  }

  /** The series' value at `t`: its latest point at or before it. */
  function valueAt(series, t) {
    let value = null;
    for (const point of series.points) {
      if (point.t > t) break;
      value = point.v;
    }
    return value;
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo;
    const raw = span / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step =
      [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count) ?? 10 * magnitude;
    const ticks = [];
    for (let i = Math.floor(lo / step); i <= Math.ceil(hi / step); i++) ticks.push(i * step);
    return { ticks, step };
  }

  const TIME_STEPS = [
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    7 * DAY,
    14 * DAY,
    28 * DAY,
  ];

  /** Tick times at whole local hours or local midnights, at most `count` of them. */
  function timeTicks(x0, x1, count) {
    const step =
      TIME_STEPS.find((s) => (x1 - x0) / s <= count) ?? TIME_STEPS[TIME_STEPS.length - 1];
    const ticks = [];
    const date = new Date(x0);
    if (step < DAY) {
      const hours = step / HOUR;
      date.setMinutes(0, 0, 0);
      while (date.getTime() < x0 || date.getHours() % hours !== 0)
        date.setHours(date.getHours() + 1);
      while (date.getTime() <= x1) {
        ticks.push(date.getTime());
        date.setHours(date.getHours() + hours);
      }
    } else {
      const days = Math.round(step / DAY);
      date.setHours(0, 0, 0, 0);
      while (date.getTime() < x0) date.setDate(date.getDate() + 1);
      while (date.getTime() <= x1) {
        ticks.push(date.getTime());
        date.setDate(date.getDate() + days);
      }
    }
    return { ticks, step };
  }

  function timeTickLabel(t, step, x0, x1) {
    const date = new Date(t);
    if (step >= DAY) return dayOnly.format(date);
    return x1 - x0 > DAY ? weekdayHour.format(date) : hourOnly.format(date);
  }

  function renderLegend(series) {
    $('chart-legend').replaceChildren(
      ...series.map((s) => {
        const last = s.points[s.points.length - 1];
        return el(
          'li',
          { class: `series-${s.series}` },
          el('span', { class: 'key', 'aria-hidden': 'true' }),
          el('span', { text: s.name }),
          last ? el('span', { class: 'legend-value' }, pnlNode(last.v)) : null,
        );
      }),
    );
  }

  function renderChart() {
    const host = $('chart');
    const series = chartSeries();
    renderLegend(series);
    renderChartTable(series);
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort(
      (a, b) => a - b,
    );
    const latest = series
      .map((s) => `${s.name} ${signedMoney(s.points[s.points.length - 1]?.v ?? 0)}`)
      .join(', ');
    host.setAttribute('aria-label', `Profit and loss by strategy. Latest: ${latest}.`);
    host.classList.toggle('chart-empty', times.length < 2);
    if (times.length < 2) {
      host.replaceChildren(
        el('p', {
          class: 'empty',
          text: 'The chart starts once the engine has traded for a few minutes.',
        }),
      );
      return;
    }

    const width = Math.max(280, host.clientWidth || 640);
    chartWidth = width;
    const height = 300;
    const roomForLabels = width >= 560;
    const margin = { top: 14, right: roomForLabels ? 132 : 18, bottom: 30, left: 70 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const x0 = times[0];
    const x1 = times[times.length - 1];

    const values = series.flatMap((s) => s.points.map((p) => p.v));
    let lo = Math.min(0, ...values);
    let hi = Math.max(0, ...values);
    if (hi - lo < 2) {
      // Flat at zero so far: give the zero line room in the middle.
      hi += 10;
      lo -= 10;
    }
    const { ticks: yTicks, step: yStep } = niceTicks(lo, hi, 5);
    lo = yTicks[0];
    hi = yTicks[yTicks.length - 1];

    const X = (t) => margin.left + ((t - x0) / (x1 - x0)) * plotW;
    const Y = (v) => margin.top + ((hi - v) / (hi - lo)) * plotH;
    const tickMoney = (v) => {
      const text = (yStep < 1 ? usd : usd0).format(Math.abs(v));
      return v < 0 ? MINUS + text : text;
    };

    const root = svg('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      'aria-hidden': 'true',
      focusable: 'false',
    });

    for (const v of yTicks) {
      const y = Math.round(Y(v)) + 0.5;
      root.append(
        svg('line', {
          class: v === 0 ? 'zero' : 'grid',
          x1: margin.left,
          x2: margin.left + plotW,
          y1: y,
          y2: y,
        }),
      );
      const label = svg('text', {
        class: 'tick',
        x: margin.left - 10,
        y: y + 4,
        'text-anchor': 'end',
      });
      label.textContent = tickMoney(v);
      root.append(label);
    }

    const { ticks: xTicks, step: xStep } = timeTicks(x0, x1, Math.max(2, Math.floor(plotW / 110)));
    if (xTicks.length >= 2) {
      for (const t of xTicks) {
        const label = svg('text', {
          class: 'tick',
          x: X(t),
          y: height - 8,
          'text-anchor': 'middle',
        });
        label.textContent = timeTickLabel(t, xStep, x0, x1);
        root.append(label);
      }
    } else {
      // Less than an hour or so of history: label the two ends instead.
      for (const [t, anchor] of [
        [x0, 'start'],
        [x1, 'end'],
      ]) {
        const label = svg('text', { class: 'tick', x: X(t), y: height - 8, 'text-anchor': anchor });
        label.textContent = when(t);
        root.append(label);
      }
    }

    for (const s of series) {
      if (!s.points.length) continue;
      const d = s.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`)
        .join('');
      root.append(svg('path', { class: `line series-${s.series}`, d }));
    }
    for (const s of series) {
      const last = s.points[s.points.length - 1];
      if (last)
        root.append(
          svg('circle', { class: `dot series-${s.series}`, cx: X(last.t), cy: Y(last.v), r: 4 }),
        );
    }

    // Direct labels at the line ends, only where they won't collide; the legend
    // always carries the names.
    if (roomForLabels) {
      const ends = series
        .filter((s) => s.points.length)
        .map((s) => ({ name: s.name, y: Y(s.points[s.points.length - 1].v) }))
        .sort((a, b) => a.y - b.y);
      const clear = ends.every((end, i) => i === 0 || end.y - ends[i - 1].y >= 16);
      if (clear) {
        for (const end of ends) {
          const label = svg('text', { class: 'end-label', x: X(x1) + 10, y: end.y + 4 });
          label.textContent = end.name;
          root.append(label);
        }
      }
    }

    // Hover and keyboard: a crosshair that snaps to the nearest time, and one
    // tooltip listing every strategy there.
    const crosshair = svg('line', {
      class: 'crosshair',
      y1: margin.top,
      y2: margin.top + plotH,
      visibility: 'hidden',
    });
    const hit = svg('rect', {
      class: 'hit',
      x: margin.left,
      y: margin.top,
      width: plotW,
      height: plotH,
    });
    root.append(crosshair, hit);
    const tooltip = el('div', { class: 'tooltip', hidden: true });
    host.replaceChildren(root, tooltip);

    let active = -1;
    const show = (index) => {
      active = Math.max(0, Math.min(times.length - 1, index));
      const t = times[active];
      chartHover = t;
      const x = Math.round(X(t)) + 0.5;
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('visibility', 'visible');
      tooltip.replaceChildren(
        el('div', { class: 'tooltip-time', text: dayTime.format(new Date(t)) }),
        ...series.map((s) => {
          const value = valueAt(s, t);
          return el(
            'div',
            { class: `tooltip-row series-${s.series}` },
            el('span', { class: 'key', 'aria-hidden': 'true' }),
            el('strong', { text: value === null ? '—' : signedMoney(value) }),
            el('span', { text: s.name }),
          );
        }),
      );
      tooltip.hidden = false;
      const room = host.clientWidth - tooltip.offsetWidth - 8;
      const left =
        x + 14 + tooltip.offsetWidth > host.clientWidth ? x - 14 - tooltip.offsetWidth : x + 14;
      tooltip.style.left = `${Math.max(0, Math.min(room, left))}px`;
    };
    const hide = () => {
      active = -1;
      chartHover = null;
      crosshair.setAttribute('visibility', 'hidden');
      tooltip.hidden = true;
    };
    const nearest = (clientX) => {
      const box = root.getBoundingClientRect();
      const x = ((clientX - box.left) / box.width) * width;
      let best = 0;
      for (let i = 1; i < times.length; i++) {
        if (Math.abs(X(times[i]) - x) < Math.abs(X(times[best]) - x)) best = i;
      }
      return best;
    };
    hit.addEventListener('pointermove', (event) => show(nearest(event.clientX)));
    hit.addEventListener('pointerdown', (event) => show(nearest(event.clientX)));
    hit.addEventListener('pointerleave', hide);
    host.onkeydown = (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const from = active === -1 ? times.length - 1 : active;
        show(from + (event.key === 'ArrowLeft' ? -1 : 1));
      } else if (event.key === 'Escape') {
        hide();
      }
    };
    host.onfocus = () => show(times.length - 1);
    host.onblur = hide;
    // A refresh redraws the chart; keep the reader's place. The newest point
    // moves on every refresh, so it follows to the new newest.
    if (chartHover !== null) {
      const kept = times.indexOf(chartHover);
      show(kept === -1 ? times.length - 1 : kept);
    }
  }

  function renderChartTable(series) {
    const container = $('chart-table');
    const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort(
      (a, b) => b - a,
    );
    container.replaceChildren(
      el(
        'div',
        { class: 'table-scroll' },
        el(
          'table',
          {},
          el('caption', {
            class: 'visually-hidden',
            text: 'Profit and loss by strategy over time',
          }),
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { scope: 'col', text: 'Time' }),
              series.map((s) => el('th', { scope: 'col', class: 'num', text: s.name })),
            ),
          ),
          el(
            'tbody',
            {},
            times.map((t) =>
              el(
                'tr',
                {},
                el('th', { scope: 'row', text: dayTime.format(new Date(t)) }),
                series.map((s) => {
                  const value = valueAt(s, t);
                  return el('td', { class: 'num' }, value === null ? '—' : pnlNode(value));
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // ---- Strategy cards ------------------------------------------------------------------

  function renderStrategies(status) {
    const paper = status.paperEquity || 10_000;
    const cards = [];
    for (const id of ORDER) {
      const meta = STRATEGIES[id];
      if (id === 'F4') {
        if (status.rotation) {
          const r = status.rotation;
          cards.push(
            strategyCard(
              id,
              meta,
              r.equity - paper,
              paper,
              r.trades || 0,
              r.wins || 0,
              rotationDetails(r),
            ),
          );
        }
        continue;
      }
      const accounts = status.accounts.filter((a) => a.strategy === id);
      if (!accounts.length) continue;
      const base = accounts.length * paper;
      cards.push(
        strategyCard(
          id,
          meta,
          sum(accounts, (a) => a.equity) - base,
          base,
          sum(accounts, (a) => a.trades || 0),
          sum(accounts, (a) => a.wins || 0),
          coinRows(accounts, paper),
        ),
      );
    }
    $('strategies').replaceChildren(...cards);
  }

  function fact(label, value) {
    return el('div', {}, el('dt', { text: label }), el('dd', { text: value }));
  }

  function strategyCard(id, meta, pnl, base, trades, wins, details) {
    return el(
      'article',
      { class: `card strategy series-${meta.series}`, 'aria-labelledby': `strategy-${id}` },
      el(
        'div',
        { class: 'strategy-head' },
        el('span', { class: 'key', 'aria-hidden': 'true' }),
        el('h3', { id: `strategy-${id}`, text: meta.name }),
        el('span', { class: 'code', title: 'Its name in the experiment docs', text: id }),
      ),
      el('p', { class: 'strategy-blurb', text: meta.blurb }),
      el(
        'p',
        { class: 'strategy-pnl' },
        pnlNode(pnl),
        el('span', { class: 'muted', text: `${signedPct(pnl / base)} of ${usd0.format(base)}` }),
      ),
      el(
        'dl',
        { class: 'facts' },
        fact('Trades closed', String(trades)),
        fact('Won', trades ? `${wins} of ${trades}` : '—'),
        fact('Holds trades', meta.holds),
      ),
      details,
    );
  }

  function accountState(account) {
    const position = account.position;
    if (position) {
      return {
        level: 'active',
        text: `${sideName(position.direction)} since ${when(position.entryTime * 1000)}`,
        title: position.reason,
      };
    }
    if (account.halted)
      return { level: 'warning', text: 'Paused until 00:00 UTC (hit its daily loss limit)' };
    if (account.pendingEntry) return { level: 'info', text: 'Entering at the next bar' };
    return { level: 'info', text: 'Waiting for a setup' };
  }

  function coinRows(accounts, paper) {
    return el(
      'ul',
      { class: 'rows', 'aria-label': 'Coins' },
      accounts.map((account) => {
        const state = accountState(account);
        return el(
          'li',
          {},
          el('span', { class: 'coin', text: coin(account.productId) }),
          el(
            'span',
            { class: 'state' },
            el('span', { class: 'level-icon', 'data-level': state.level, 'aria-hidden': 'true' }),
            el('span', { text: state.text, title: state.title || state.text }),
          ),
          pnlNode(account.equity - paper),
        );
      }),
    );
  }

  function chips(label, holdings) {
    return el(
      'div',
      { class: 'chips' },
      el('span', { class: 'chips-label', text: label }),
      holdings.length
        ? holdings.map((h) =>
            el('span', {
              class: 'chip',
              title: `Open P&L ${signedMoney(h.openPnl)}`,
              text: coin(h.productId),
            }),
          )
        : el('span', { class: 'note', text: 'none' }),
    );
  }

  function rotationDetails(rotation) {
    const next = nextMondayUtc(Date.now());
    const nodes = [
      el(
        'p',
        { class: 'note' },
        `Next rebalance ${until(next)}: `,
        el('strong', { text: dayTime.format(new Date(next)) }),
        ' your time (Monday 00:00 UTC).',
      ),
    ];
    if (!rotation.positions.length) {
      nodes.push(
        el('p', {
          class: 'note',
          text: rotation.trades
            ? 'Not holding anything right now.'
            : 'Not holding anything yet: its first trades are at the next rebalance.',
        }),
      );
    } else {
      nodes.push(
        chips(
          'Long',
          rotation.positions.filter((h) => h.direction === 'LONG'),
        ),
        chips(
          'Short',
          rotation.positions.filter((h) => h.direction === 'SHORT'),
        ),
      );
    }
    return el('div', { class: 'strategy-rotation' }, ...nodes);
  }

  // ---- Tables ----------------------------------------------------------------------------

  function table(caption, columns, rows) {
    return el(
      'div',
      { class: 'table-scroll' },
      el(
        'table',
        {},
        el('caption', { class: 'visually-hidden', text: caption }),
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            columns.map((c) =>
              el('th', { scope: 'col', class: c.num ? 'num' : null, text: c.label }),
            ),
          ),
        ),
        el('tbody', {}, rows),
      ),
    );
  }

  function cell(content, options = {}) {
    return el(
      'td',
      { class: options.num ? 'num' : null },
      content,
      options.sub ? el('span', { class: 'sub', text: options.sub }) : null,
    );
  }

  function renderPositions(status) {
    const rows = status.accounts
      .filter((account) => account.position)
      .map((account) => ({ account, p: account.position }))
      .sort((a, b) => b.p.entryTime - a.p.entryTime);
    const holdings = status.rotation ? status.rotation.positions : [];
    const parts = [];
    if (rows.length) {
      parts.push(
        table(
          'Open paper positions',
          [
            { label: 'Strategy' },
            { label: 'Coin' },
            { label: 'Side' },
            { label: 'Entry', num: true },
            { label: 'Now', num: true },
            { label: 'Open P&L', num: true },
            { label: 'Stop', num: true },
            { label: 'Target', num: true },
            { label: 'Opened' },
          ],
          rows.map(({ account, p }) =>
            el(
              'tr',
              {},
              cell(nameOf(account.strategy), { sub: p.reason }),
              cell(coin(account.productId)),
              cell(el('span', { class: 'side', text: sideName(p.direction) })),
              cell(price(p.entryPrice), { num: true }),
              cell(price(account.markPrice), { num: true }),
              cell(pnlNode(account.openPnl ?? 0), {
                num: true,
                sub: signedPct((account.openPnl ?? 0) / (p.size * p.entryPrice)),
              }),
              cell(price(p.stop), { num: true }),
              cell(price(p.target), { num: true }),
              cell(when(p.entryTime * 1000), { sub: `closes by ${when(p.deadline * 1000)}` }),
            ),
          ),
        ),
      );
    } else if (holdings.length) {
      parts.push(
        el('p', {
          class: 'empty',
          text: 'Flush catcher, squeeze breakout and trend pullback have no open trades right now.',
        }),
      );
    }
    if (holdings.length) parts.push(rotationHoldings(holdings));
    if (!parts.length) {
      parts.push(
        el('p', {
          class: 'empty',
          text: 'No open positions. Each strategy waits for its own setup, which can take hours.',
        }),
      );
    }
    $('positions').replaceChildren(...parts);
  }

  /** Weekly momentum holds many coins at once: one summary line, the coins on demand. */
  function rotationHoldings(holdings) {
    const longs = holdings.filter((h) => h.direction === 'LONG').length;
    const since = Math.min(...holdings.map((h) => h.openedAt)) * 1000;
    const details = el(
      'details',
      { class: 'holdings', open: holdingsOpen },
      el(
        'summary',
        {},
        el('span', {
          class: 'holdings-title',
          text: `Weekly momentum holds ${holdings.length} coins: ${longs} long, ${holdings.length - longs} short`,
        }),
        el(
          'span',
          { class: 'holdings-meta' },
          'Open P&L ',
          pnlNode(sum(holdings, (h) => h.openPnl || 0)),
          ` · since ${when(since)}`,
        ),
      ),
      table(
        'Weekly momentum holdings',
        [
          { label: 'Coin' },
          { label: 'Side' },
          { label: 'Entry', num: true },
          { label: 'Now', num: true },
          { label: 'Open P&L', num: true },
          { label: 'Stop', num: true },
        ],
        [...holdings]
          .sort((a, b) => (b.openPnl || 0) - (a.openPnl || 0))
          .map((h) =>
            el(
              'tr',
              {},
              cell(coin(h.productId)),
              cell(el('span', { class: 'side', text: sideName(h.direction) })),
              cell(price(h.averageEntry), { num: true }),
              cell(price(h.markPrice), { num: true }),
              cell(pnlNode(h.openPnl || 0), {
                num: true,
                sub: signedPct((h.openPnl || 0) / (h.size * h.averageEntry)),
              }),
              cell(price(h.stop), { num: true }),
            ),
          ),
      ),
    );
    // A refresh rebuilds this; keep it open if the reader opened it.
    details.addEventListener('toggle', () => {
      holdingsOpen = details.open;
    });
    return details;
  }

  function renderTrades(trades) {
    const container = $('trades');
    if (!trades.length) {
      container.replaceChildren(
        el('p', {
          class: 'empty',
          text: 'No closed trades yet. They appear here, newest first, as each one finishes.',
        }),
      );
      return;
    }
    container.replaceChildren(
      table(
        'Recent closed paper trades',
        [
          { label: 'Closed' },
          { label: 'Strategy' },
          { label: 'Coin' },
          { label: 'Side' },
          { label: 'Entry', num: true },
          { label: 'Exit', num: true },
          { label: 'Result', num: true },
          { label: 'Why it closed' },
        ],
        trades.map((t) =>
          el(
            'tr',
            {},
            cell(when(t.exit_time * 1000), { sub: `held ${spell(t.exit_time - t.entry_time)}` }),
            cell(nameOf(strategyOf(t.account_id)), { sub: t.reason }),
            cell(coin(t.product_id)),
            cell(el('span', { class: 'side', text: sideName(t.direction) })),
            cell(price(t.entry_price), { num: true }),
            cell(price(t.exit_price), { num: true }),
            cell(pnlNode(t.net_pnl), {
              num: true,
              sub: `${signedPct(t.return_on_equity)} of its account`,
            }),
            cell(EXIT_REASONS[t.exit_reason] || t.exit_reason),
          ),
        ),
      ),
    );
  }

  // ---- Activity ---------------------------------------------------------------------------

  /** A plain-English headline for an engine event; the raw message stays as detail. */
  function describeEvent(event) {
    const message = String(event.message);
    let match;
    if (event.kind === 'engine_started') return ['Engine started'];
    if (
      event.kind === 'opened' &&
      (match = /^(F\d):([A-Z0-9]+)-USD opened (LONG|SHORT)/.exec(message))
    ) {
      return [`${nameOf(match[1])} went ${sideName(match[3]).toLowerCase()} on ${match[2]}`];
    }
    if (
      event.kind === 'closed' &&
      (match = /^(F\d):\S+ closed (LONG|SHORT) ([A-Z0-9]+)-USD by (\w+):.*net (-?[\d.]+)/.exec(
        message,
      ))
    ) {
      const reason = (EXIT_REASONS[match[4]] || match[4]).toLowerCase();
      return [
        `${nameOf(match[1])} closed its ${match[3]} ${sideName(match[2]).toLowerCase()} (${reason}): `,
        pnlNode(Number(match[5])),
      ];
    }
    if (event.kind === 'halted' && (match = /^(F\d):([A-Z0-9]+)-USD/.exec(message))) {
      return [`${nameOf(match[1])} paused ${match[2]} for the rest of the day`];
    }
    if (event.kind === 'tick_failed') return ['Couldn’t read prices; it retries shortly'];
    const kind = String(event.kind).replace(/_/g, ' ');
    return [kind.charAt(0).toUpperCase() + kind.slice(1)];
  }

  function renderActivity(events) {
    const list = $('activity');
    if (!events.length) {
      list.replaceChildren(el('li', { class: 'empty', text: 'Nothing yet.' }));
      return;
    }
    list.replaceChildren(
      ...events.map((event) =>
        el(
          'li',
          {},
          el('span', {
            class: 'level-icon',
            'data-level':
              event.level === 'warning' || event.level === 'critical' ? event.level : 'info',
            'aria-hidden': 'true',
          }),
          el(
            'div',
            {},
            el('p', { class: 'activity-title' }, ...describeEvent(event)),
            el(
              'p',
              { class: 'activity-detail' },
              el('time', {
                datetime: new Date(event.at).toISOString(),
                title: dayTime.format(new Date(event.at)),
                text: ago(event.at),
              }),
              ` · ${event.message}`,
            ),
          ),
        ),
      ),
    );
  }

  // ---- Theme -------------------------------------------------------------------------------

  const THEME_KEY = 'futures-dashboard-theme';
  const THEMES = ['auto', 'light', 'dark'];

  function readTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return THEMES.includes(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  }

  function applyTheme(theme) {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    $('theme-toggle').textContent = `Theme: ${theme}`;
  }

  let theme = readTheme();
  applyTheme(theme);
  $('theme-toggle').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Private windows can refuse storage; the choice then lasts until reload.
    }
  });

  // ---- Start ---------------------------------------------------------------------------------

  $('chart-table-toggle').addEventListener('click', () => {
    const button = $('chart-table-toggle');
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Hide the table' : 'Show as a table';
    $('chart-table').hidden = !open;
  });

  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      const width = $('chart').clientWidth;
      if (snapshot && Math.abs(width - chartWidth) > 4) renderChart();
    }).observe($('chart'));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
    else clearTimeout(pollTimer);
  });

  setInterval(() => {
    if (snapshot || offline) renderConnection();
  }, 1000);

  refresh();
})();
