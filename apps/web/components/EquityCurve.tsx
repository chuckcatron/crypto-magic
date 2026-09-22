'use client';

import { useMemo, useRef, useState } from 'react';
import type { EquityPoint } from '@/lib/api';
import { money } from '@/lib/api';

const WIDTH = 900;
const HEIGHT = 260;
const PAD = { top: 16, right: 68, bottom: 30, left: 8 };

interface Props {
  points: EquityPoint[];
  startingEquity: number | null;
}

/**
 * Account equity over time.
 *
 * One series, so there is no legend — the panel title names it — and no
 * categorical palette to validate. The line is the accent hue; nothing else in
 * the plot competes with it. Gain and loss are never encoded by line color: the
 * value readout carries a sign, which survives any kind of color vision.
 */
/** Short date, or a time when the whole window is inside one day. */
function formatTick(ts: number | undefined): string {
  if (ts === undefined) return '';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function EquityCurve({ points, startingEquity }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null);

  const model = useMemo(() => {
    const values = points.map((p) => Number.parseFloat(p.equity)).filter(Number.isFinite);
    if (values.length < 2) return null;

    const min = Math.min(...values, startingEquity ?? Infinity);
    const max = Math.max(...values, startingEquity ?? -Infinity);
    // A flat line should sit mid-plot rather than collapse onto an edge.
    const pad = max === min ? Math.max(1, Math.abs(max) * 0.02) : (max - min) * 0.08;
    const lo = min - pad;
    const hi = max + pad;

    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (i / (values.length - 1)) * plotW;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;

    return {
      values,
      x,
      y,
      lo,
      hi,
      plotW,
      plotH,
      path: values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' '),
      area:
        `M${x(0).toFixed(2)},${(PAD.top + plotH).toFixed(2)} ` +
        values.map((v, i) => `L${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ') +
        ` L${x(values.length - 1).toFixed(2)},${(PAD.top + plotH).toFixed(2)} Z`,
      ticks: [lo, (lo + hi) / 2, hi],
      // First / middle / last. A time series with no time axis leaves the
      // reader unable to tell a week from a year.
      timeTicks: [0, Math.floor((values.length - 1) / 2), values.length - 1].map((i) => ({
        i,
        label: formatTick(points[i]?.ts),
      })),
    };
  }, [points, startingEquity]);

  if (!model) {
    return <p className="empty">Not enough history yet — the curve appears after a few engine ticks.</p>;
  }

  const last = model.values[model.values.length - 1]!;
  const hovered = hover ? model.values[hover.index] : null;
  const hoveredPoint = hover ? points[hover.index] : null;

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const svgX = ratio * WIDTH;
    const index = Math.round(((svgX - PAD.left) / model.plotW) * (model.values.length - 1));
    if (index < 0 || index >= model.values.length) return setHover(null);
    setHover({ index, x: ratio * rect.width });
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
            key={tick.i}
            className="tick"
            x={model.x(tick.i)}
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

        <path d={model.area} fill="var(--series-1-wash)" />
        <path
          d={model.path}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Direct label on the current value — no legend needed for one series. */}
        <circle
          cx={model.x(model.values.length - 1)}
          cy={model.y(last)}
          r={4}
          fill="var(--series-1)"
          stroke="var(--surface-1)"
          strokeWidth={2}
        />

        {hover && hovered !== null && (
          <>
            <line
              x1={model.x(hover.index)}
              x2={model.x(hover.index)}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            <circle
              cx={model.x(hover.index)}
              cy={model.y(hovered)}
              r={5}
              fill="var(--series-1)"
              stroke="var(--surface-1)"
              strokeWidth={2}
            />
          </>
        )}
      </svg>

      {hover && hovered !== null && hoveredPoint && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(hover.x + 12, 0), (wrapRef.current?.clientWidth ?? 0) - 160),
            top: 8,
          }}
        >
          <div className="tooltip-value">{money(hovered)}</div>
          <div className="tooltip-time">{new Date(hoveredPoint.ts).toLocaleString()}</div>
        </div>
      )}
    </div>
  );
}
