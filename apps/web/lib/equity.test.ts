import { describe, expect, it } from 'vitest';
import {
  MIN_GAP_MS,
  formatDuration,
  gapAt,
  gapThresholdMs,
  nearestIndex,
  splitAtGaps,
} from './equity';

const S = 1000;
const MIN = 60 * S;

/** A snapshot every 30s from `start`, `count` of them. */
const run = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => start + i * 30 * S);

describe('gapThresholdMs', () => {
  it('uses the floor for a 30s tick', () => {
    expect(gapThresholdMs(run(0, 100))).toBe(MIN_GAP_MS);
  });

  it('scales with a slower tick, so every ordinary step is not a gap', () => {
    const tenMinutes = Array.from({ length: 20 }, (_, i) => i * 10 * MIN);
    expect(gapThresholdMs(tenMinutes)).toBe(50 * MIN);
  });

  it('is not dragged up by the gaps themselves', () => {
    // Mostly 30s steps with a few long outages: the median ignores them.
    const ts = [...run(0, 50), ...run(2 * 3600 * S, 50), ...run(5 * 3600 * S, 50)];
    expect(gapThresholdMs(ts)).toBe(MIN_GAP_MS);
  });

  it('falls back to the floor with too few points to measure', () => {
    expect(gapThresholdMs([])).toBe(MIN_GAP_MS);
    expect(gapThresholdMs([5])).toBe(MIN_GAP_MS);
  });
});

describe('splitAtGaps', () => {
  it('keeps unbroken data as one segment', () => {
    expect(splitAtGaps(run(0, 10), MIN_GAP_MS)).toEqual({ segments: [[0, 9]], gaps: [] });
  });

  it('splits at a 15-minute dark-wake gap and reports where it was', () => {
    const before = run(0, 5);
    const after = run(before.at(-1)! + 15 * MIN, 5);
    const { segments, gaps } = splitAtGaps([...before, ...after], MIN_GAP_MS);
    expect(segments).toEqual([
      [0, 4],
      [5, 9],
    ]);
    expect(gaps).toEqual([{ from: before.at(-1), to: after[0] }]);
  });

  it('does not split on a single skipped tick', () => {
    const ts = [0, 30 * S, 90 * S, 120 * S];
    expect(splitAtGaps(ts, MIN_GAP_MS).segments).toEqual([[0, 3]]);
  });

  it('gives a lone point between two gaps its own segment', () => {
    const ts = [0, 30 * MIN, 60 * MIN];
    expect(splitAtGaps(ts, MIN_GAP_MS).segments).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('handles no data', () => {
    expect(splitAtGaps([], MIN_GAP_MS)).toEqual({ segments: [], gaps: [] });
  });
});

describe('nearestIndex', () => {
  const ts = [0, 10, 20, 100];

  it('finds the closest point on either side', () => {
    expect(nearestIndex(ts, 4)).toBe(0);
    expect(nearestIndex(ts, 6)).toBe(1);
    expect(nearestIndex(ts, 70)).toBe(3);
  });

  it('clamps outside the range', () => {
    expect(nearestIndex(ts, -50)).toBe(0);
    expect(nearestIndex(ts, 500)).toBe(3);
  });

  it('works with a single point', () => {
    expect(nearestIndex([42], 0)).toBe(0);
  });
});

describe('gapAt', () => {
  const gaps = [{ from: 100, to: 200 }];

  it('finds a time strictly inside a gap', () => {
    expect(gapAt(gaps, 150)).toEqual(gaps[0]);
  });

  it('treats the snapshots bounding a gap as data, not downtime', () => {
    expect(gapAt(gaps, 100)).toBeUndefined();
    expect(gapAt(gaps, 200)).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0m'],
    [15 * MIN, '15m'],
    [60 * MIN, '1h'],
    [190 * MIN, '3h 10m'],
    [48 * 60 * MIN, '2d'],
    [52 * 60 * MIN, '2d 4h'],
  ])('%i ms reads %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
