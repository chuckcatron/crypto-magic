import { DAY } from '@crypto-magic/futures';
import { describe, expect, it } from 'vitest';
import { pnlHistory } from './pnl-history';

/** Tuesday 2026-10-06 19:25 UTC, and that day's 00:00. */
const STARTED = Date.UTC(2026, 9, 6, 19, 25) / 1000;
const TUESDAY = Date.UTC(2026, 9, 6) / 1000;

describe('pnlHistory', () => {
  it('starts at zero, sums sub-accounts at each day close since the start, and ends now', () => {
    const now = TUESDAY + 2 * DAY + 3600;
    const [f1] = pnlHistory(
      [
        {
          strategy: 'F1',
          // Warmup marks before the start are never points.
          daily: [
            { day: TUESDAY - DAY, equity: 10_000 },
            { day: TUESDAY, equity: 10_050 },
            { day: TUESDAY + DAY, equity: 10_020 },
          ],
          equity: 10_030,
        },
        // This one has no mark yet for the second day: it counts at its last one.
        { strategy: 'F1', daily: [{ day: TUESDAY, equity: 9_990 }], equity: 9_980 },
      ],
      10_000,
      STARTED,
      now,
    );
    expect(f1).toEqual({
      strategy: 'F1',
      accounts: 2,
      points: [
        { t: STARTED, pnl: 0 },
        { t: TUESDAY + DAY, pnl: 40 },
        { t: TUESDAY + 2 * DAY, pnl: 10 },
        { t: now, pnl: 10 },
      ],
    });
  });

  it('counts a sub-account at its starting equity before its first mark', () => {
    const now = TUESDAY + DAY + 60;
    const [f4] = pnlHistory([{ strategy: 'F4', daily: [], equity: 10_000 }], 10_000, STARTED, now);
    expect(f4!.points).toEqual([
      { t: STARTED, pnl: 0 },
      { t: now, pnl: 0 },
    ]);
  });

  it('keeps strategies in first-seen order', () => {
    const ids = pnlHistory(
      ['F2', 'F1', 'F2', 'F4'].map((strategy) => ({ strategy, daily: [], equity: 10_000 })),
      10_000,
      STARTED,
      STARTED + 60,
    ).map((s) => [s.strategy, s.accounts]);
    expect(ids).toEqual([
      ['F2', 2],
      ['F1', 1],
      ['F4', 1],
    ]);
  });

  it('gives a single point before the first trading bar', () => {
    const [f1] = pnlHistory(
      [{ strategy: 'F1', daily: [], equity: 10_000 }],
      10_000,
      STARTED,
      STARTED - 30,
    );
    expect(f1!.points).toEqual([{ t: STARTED, pnl: 0 }]);
  });
});
