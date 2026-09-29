'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { dollars, type Scenario } from '@/lib/planner';

/** Below this the chart switches to its compact layout: shorter plot, short end labels. */
const NARROW = 600;
interface Layout {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
  /** Use short end labels. */
  narrow: boolean;
}

function layoutFor(width: number): Layout {
  const narrow = width < NARROW;
  return {
    width,
    height: narrow ? 240 : 300,
    pad: { top: 16, right: narrow ? 96 : 132, bottom: 30, left: 8 },
    narrow,
  };
}

/** Closest two end labels may sit, in viewBox units, before they are pushed apart. */
const LABEL_GAP = 16;

/**
 * Categorical slots 1–3 in fixed order, so a scenario keeps its color whatever
 * the inputs. Each also has its own dash, so identity never rests on color
 * alone (slot 3 is below 3:1 on the light surface; the labels and the table
 * carry it there).
 */
export const SERIES_STYLE: Record<Scenario['key'], { color: string; dash?: string }> = {
  expected: { color: 'var(--series-1)' },
  strong: { color: 'var(--series-2)', dash: '8 5' },
  bad: { color: 'var(--series-3)', dash: '2 4' },
};

export interface ChartSeries {
  scenario: Scenario;
  /** Balance at the end of each year, year 0 (today) first. */
  yearly: number[];
}

interface Props {
  series: ChartSeries[];
  target: number;
}

/** Push labels apart vertically so none overlap, keeping their order. */
function spread(ys: number[], min: number, top: number, bottom: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    order[k].y = Math.max(order[k].y, order[k - 1].y + min);
  }
  // If that ran off the bottom, slide the stack back up.
  const overflow = order.length ? order[order.length - 1].y - bottom : 0;
  if (overflow > 0) for (const o of order) o.y = Math.max(top, o.y - overflow);
  const out: number[] = [];
  for (const o of order) out[o.i] = o.y;
  return out;
}

/** Invested balance over the years, one line per scenario, against the goal. */
export function PlannerChart({ series, target }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // Drawn at the container's real width, so text stays its CSS size on a phone
  // instead of shrinking with a scaled viewBox.
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { height: HEIGHT, pad: PAD, narrow } = layoutFor(width);
  const WIDTH = width;
  const [hover, setHover] = useState<{ year: number; x: number } | null>(null);

  const model = useMemo(() => {
    const { width: WIDTH, height: HEIGHT, pad: PAD } = layoutFor(width);
    const years = Math.max(1, ...series.map((s) => s.yearly.length - 1));
    const peak = Math.max(target, ...series.flatMap((s) => s.yearly));
    const hi = peak * 1.05;
    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (year: number) => PAD.left + (year / years) * plotW;
    const y = (v: number) => PAD.top + (1 - v / hi) * plotH;
    const paths = series.map((s) =>
      s.yearly
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`)
        .join(' '),
    );
    const labelYs = spread(
      series.map((s) => y(s.yearly[s.yearly.length - 1]) + 4),
      LABEL_GAP,
      PAD.top + 4,
      PAD.top + plotH,
    );
    const step = years <= 12 ? 2 : years <= 30 ? 5 : 10;
    const yearTicks: number[] = [];
    for (let t = 0; t <= years; t += step) yearTicks.push(t);
    return { years, hi, plotW, plotH, x, y, paths, labelYs, yearTicks };
  }, [series, target, width]);

  const thisYear = new Date().getFullYear();

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const fraction = (ratio * WIDTH - PAD.left) / model.plotW;
    if (fraction < 0 || fraction > 1.02) return setHover(null);
    const year = Math.min(model.years, Math.max(0, Math.round(fraction * model.years)));
    setHover({ year, x: ratio * rect.width });
  };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Projected balance over ${model.years} years for ${series.length} scenarios against a goal of ${dollars(target)}. The table below lists the same figures.`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {[0, model.hi / 2, model.hi].map((tick) => (
          <line
            key={tick}
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={model.y(tick)}
            y2={model.y(tick)}
            stroke={tick === 0 ? 'var(--baseline)' : 'var(--gridline)'}
            strokeWidth={1}
          />
        ))}
        {[model.hi / 2, model.hi].map((tick) => (
          <text
            key={tick}
            className="tick"
            x={WIDTH - PAD.right - 4}
            y={model.y(tick) - 6}
            textAnchor="end"
          >
            {dollars(tick)}
          </text>
        ))}

        {model.yearTicks.map((year, n) => (
          <text
            key={year}
            className="tick"
            x={model.x(year)}
            y={HEIGHT - 8}
            textAnchor={n === 0 ? 'start' : 'middle'}
          >
            {year === 0 ? 'Today' : `${year}y`}
          </text>
        ))}

        {/* The goal. Above it is the whole point. */}
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={model.y(target)}
          y2={model.y(target)}
          stroke="var(--text-muted)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <text className="tick" x={PAD.left + 4} y={model.y(target) - 6}>
          Goal {dollars(target)}
        </text>

        {series.map((s, i) => {
          const style = SERIES_STYLE[s.scenario.key];
          const last = s.yearly.length - 1;
          return (
            <g key={s.scenario.key}>
              <path
                d={model.paths[i]}
                fill="none"
                stroke={style.color}
                strokeWidth={2}
                strokeDasharray={style.dash}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <circle
                cx={model.x(last)}
                cy={model.y(s.yearly[last])}
                r={4}
                fill={style.color}
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
              <text className="chart-label" x={WIDTH - PAD.right + 10} y={model.labelYs[i]}>
                {narrow ? s.scenario.short : s.scenario.label}
              </text>
            </g>
          );
        })}

        {hover && (
          <>
            <line
              x1={model.x(hover.year)}
              x2={model.x(hover.year)}
              y1={PAD.top}
              y2={HEIGHT - PAD.bottom}
              stroke="var(--baseline)"
              strokeWidth={1}
            />
            {series.map((s) => (
              <circle
                key={s.scenario.key}
                cx={model.x(hover.year)}
                cy={model.y(s.yearly[hover.year] ?? 0)}
                r={5}
                fill={SERIES_STYLE[s.scenario.key].color}
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            ))}
          </>
        )}
      </svg>

      {hover && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(hover.x + 12, 0), (wrapRef.current?.clientWidth ?? 0) - 220),
            top: 8,
          }}
        >
          <div className="tooltip-time">
            {hover.year === 0 ? 'Today' : `Year ${hover.year} (${thisYear + hover.year})`}
          </div>
          {series.map((s) => (
            <div key={s.scenario.key} className="tooltip-row">
              <span
                className="swatch"
                style={{ background: SERIES_STYLE[s.scenario.key].color }}
                aria-hidden="true"
              />
              <span className="tooltip-name">{s.scenario.label}</span>
              <span className="tooltip-num">{dollars(s.yearly[hover.year] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
