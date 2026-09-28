/**
 * Time-axis helpers for the equity chart. Pure, so they are tested without a DOM.
 *
 * The engine records a snapshot every tick while it runs and nothing while it
 * is stopped or the Mac is asleep. Spacing points by index hid those stretches
 * entirely: four hours of downtime drew as one ordinary step. These place
 * points by time and find the stretches with no data, so the chart can show them.
 */

/** Never call a gap shorter than this "downtime", however fast the tick. */
export const MIN_GAP_MS = 3 * 60 * 1000;

/** A gap is this many typical tick intervals with no snapshot. */
const GAP_INTERVALS = 5;

export interface Gap {
  /** Last snapshot before the gap. */
  from: number;
  /** First snapshot after it. */
  to: number;
}

export interface Split {
  /** Inclusive [first, last] index ranges of unbroken data. */
  segments: [number, number][];
  gaps: Gap[];
}

/**
 * How long without a snapshot counts as the engine being off.
 *
 * Derived from the median spacing so a longer configured tick interval does not
 * turn every ordinary step into a "gap", with a floor so a skipped tick or two
 * does not either.
 */
export function gapThresholdMs(ts: readonly number[]): number {
  const steps: number[] = [];
  for (let i = 1; i < ts.length; i++) steps.push(ts[i] - ts[i - 1]);
  if (steps.length === 0) return MIN_GAP_MS;
  steps.sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)];
  return Math.max(MIN_GAP_MS, median * GAP_INTERVALS);
}

/** Split ascending timestamps into unbroken runs, and the gaps between them. */
export function splitAtGaps(ts: readonly number[], thresholdMs: number): Split {
  if (ts.length === 0) return { segments: [], gaps: [] };
  const segments: [number, number][] = [];
  const gaps: Gap[] = [];
  let start = 0;
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] > thresholdMs) {
      segments.push([start, i - 1]);
      gaps.push({ from: ts[i - 1], to: ts[i] });
      start = i;
    }
  }
  segments.push([start, ts.length - 1]);
  return { segments, gaps };
}

/** Index of the timestamp closest to `t`. `ts` must be ascending and non-empty. */
export function nearestIndex(ts: readonly number[], t: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && t - ts[lo - 1] <= ts[lo] - t) return lo - 1;
  return lo;
}

/** The gap containing `t`, if any. */
export function gapAt(gaps: readonly Gap[], t: number): Gap | undefined {
  return gaps.find((g) => t > g.from && t < g.to);
}

/** "45m", "3h 10m", "2d 4h". Rounded to the minute. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}
