'use client';

import { useMemo, useRef, useState } from 'react';
import type { EquityPoint } from '@/lib/api';
import { money } from '@/lib/api';
import {
  formatDuration,
  gapAt,
  gapThresholdMs,
  nearestIndex,
  splitAtGaps,
  type Gap,
} from '@/lib/equity';

const WIDTH = 900;
const HEIGHT = 260;
const PAD = { top: 16, right: 68, bottom: 30, left: 8 };

interface Props {
  points: EquityPoint[];
  startingEquity: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Short date, or a time when the whole window is inside one day. */
function formatTick(ts: number | undefined, spanMs: number): string {
  if (ts === undefined) return '';
  const date = new Date(ts);
  return spanMs < DAY_MS
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Start / middle / end of the time window, minus duplicates. In a short window
 * neighbouring labels can read the same, and drawing both stacks two on one spot.
 */
function timeTicks(t0: number, t1: number): { ts: number; label: string }[] {
  const spanMs = t1 - t0;
  const ticks: { ts: number; label: string }[] = [];
  for (const ts of [...new Set([t0, Math.round((t0 + t1) / 2), t1])]) {
    const label = formatTick(ts, spanMs);
    if (label && label !== ticks.at(-1)?.label) ticks.push({ ts, label });
  }
  return ticks;
}

/**
 * Account equity over time.
 *
 * One series, so there is no legend — the panel title names it — and no
 * categorical palette to validate. The line is the accent hue; nothing else in
 * the plot competes with it. Gain and loss are never encoded by line color: the
 * value readout carries a sign, which survives any kind of color vision.
 *
 * Points sit at their time, not their index, and the line breaks wherever the
 * engine recorded nothing. A shaded band marks each stretch, so a night asleep
 * reads as a night asleep rather than one unremarkable step.
 */
export function EquityCurve({ points, startingEquity }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<
    { kind: 'point'; index: number; x: number } | { kind: 'gap'; gap: Gap; x: number } | null
  >(null);

  const model = useMemo(() => {
    const usable = points.filter((p) => Number.isFinite(Number.parseFloat(p.equity)));
    if (usable.length < 2) return null;
    const values = usable.map((p) => Number.parseFloat(p.equity));
    const ts = usable.map((p) => p.ts);
    const t0 = ts[0];
    const t1 = ts[ts.length - 1];
    if (t1 <= t0) return null;

    const min = Math.min(...values, startingEquity ?? Infinity);
    const max = Math.max(...values, startingEquity ?? -Infinity);
    // A flat line should sit mid-plot rather than collapse onto an edge.
    const pad = max === min ? Math.max(1, Math.abs(max) * 0.02) : (max - min) * 0.08;
    const lo = min - pad;
    const hi = max + pad;

    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const baseY = PAD.top + plotH;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * plotW;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
    const pt = (i: number) => `${x(ts[i]).toFixed(2)},${y(values[i]).toFixed(2)}`;

    const { segments, gaps } = splitAtGaps(ts, gapThresholdMs(ts));
    const lines: string[] = [];
    const areas: string[] = [];
    const lone: number[] = [];
    for (const [first, last] of segments) {
      // One point has no line to draw; it gets a dot instead of vanishing.
      if (first === last) {
        lone.push(first);
        continue;
      }
      const run: string[] = [];
      for (let i = first; i <= last; i++) run.push(pt(i));
      lines.push(`M${run.join(' L')}`);
      areas.push(
        `M${x(ts[first]).toFixed(2)},${baseY.toFixed(2)} L${run.join(' L')} ` +
          `L${x(ts[last]).toFixed(2)},${baseY.toFixed(2)} Z`,
      );
    }

    return {
      values,
      ts,
      x,
      y,
      plotW,
      plotH,
      lines,
      areas,
      lone,
      gaps,
      ticks: [lo, (lo + hi) / 2, hi],
      // A time series with no time axis leaves the reader unable to tell a week
      // from a year.
      timeTicks: timeTicks(t0, t1),
    };
  }, [points, startingEquity]);

  if (!model) {
    return (
      <p className="empty">Not enough history yet — the curve appears after a few engine ticks.</p>
    );
  }

  const lastIndex = model.values.length - 1;
  const last = model.values[lastIndex];
  const hoveredIndex = hover?.kind === 'point' ? hover.index : null;

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const svgX = ratio * WIDTH;
    const fraction = (svgX - PAD.left) / model.plotW;
    if (fraction < 0 || fraction > 1) return setHover(null);
    const t = model.ts[0] + fraction * (model.ts[lastIndex] - model.ts[0]);
    const gap = gapAt(model.gaps, t);
    if (gap) return setHover({ kind: 'gap', gap, x: ratio * rect.width });
    setHover({ kind: 'point', index: nearestIndex(model.ts, t), x: ratio * rect.width });
  };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Account equity over time, currently ${money(last)}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {model.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={model.y(tick)}
              y2={model.y(tick)}
              stroke="var(--gridline)"
              strokeWidth={1}
            />
            <text className="tick" x={WIDTH - PAD.right + 8} y={model.y(tick) + 4}>
              {money(tick)}
            </text>
          </g>
        ))}

        {model.timeTicks.map((tick, n) => (
          <text
            key={tick.ts}
            className="tick"
            x={model.x(tick.ts)}
            y={HEIGHT - 8}
            textAnchor={n === 0 ? 'start' : n === model.timeTicks.length - 1 ? 'end' : 'middle'}
          >
            {tick.label}
          </text>
        ))}

        {/* Where the account started. Above or below it is the whole question. */}
        {startingEquity !== null && (
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={model.y(startingEquity)}
            y2={model.y(startingEquity)}
            stroke="var(--baseline)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}

        {/* Stretches with no snapshots: the engine was stopped or the Mac asleep. */}
        {model.gaps.map((gap) => (
          <rect
            key={gap.from}
            className="chart-gap"
            x={model.x(gap.from)}
            y={PAD.top}
            width={Math.max(1, model.x(gap.to) - model.x(gap.from))}
            height={model.plotH}
          />
        ))}

        {model.areas.map((d) => (
          <path key={d} d={d} fill="var(--series-1-wash)" />
        ))}
        {model.lines.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {model.lone.map((i) => (
          <circle
            key={i}
            cx={model.x(model.ts[i])}
            cy={model.y(model.values[i])}
            r={2}
            fill="var(--series-1)"
          />
        ))}

        {/* Direct label on the current value — no legend needed for one series. */}
        <circle
          cx={model.x(model.ts[lastIndex])}
          cy={model.y(last)}
          r={4}
          fill="var(--series-1)"
          stroke="var(--surface-1)"
          strokeWidth={2}
        />

        {hoveredIndex !== null && (
          <>
            <line
              x1={model.x(model.ts[hoveredIndex])}
              x2={model.x(model.ts[hoveredIndex])}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            <circle
              cx={model.x(model.ts[hoveredIndex])}
              cy={model.y(model.values[hoveredIndex])}
              r={5}
              fill="var(--series-1)"
              stroke="var(--surface-1)"
              strokeWidth={2}
            />
          </>
        )}
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(hover.x + 12, 0), (wrapRef.current?.clientWidth ?? 0) - 240),
            top: 8,
          }}
        >
          {hover.kind === 'point' ? (
            <>
              <div className="tooltip-value">{money(model.values[hover.index])}</div>
              <div className="tooltip-time">{new Date(model.ts[hover.index]).toLocaleString()}</div>
            </>
          ) : (
            <>
              <div className="tooltip-value">
                Engine not running · {formatDuration(hover.gap.to - hover.gap.from)}
              </div>
              <div className="tooltip-time">
                {new Date(hover.gap.from).toLocaleTimeString()} –{' '}
                {new Date(hover.gap.to).toLocaleString()}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
