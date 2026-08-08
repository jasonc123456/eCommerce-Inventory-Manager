import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  clampInterval,
  effectiveCadence,
  isDue,
} from './cadence';

/**
 * The adaptation rules (section 15).
 *
 * Worth testing as properties rather than examples: what matters is not that a
 * critical quota produces four minutes, but that no combination of conditions
 * can ever produce an interval shorter than the operator chose or longer than
 * section 15's ceiling.
 */

const base = {
  targetIntervalSeconds: 30,
  quotaPressure: 'normal',
  health: 'healthy',
  backlog: 0,
} as const;

describe('effectiveCadence', () => {
  it('uses the configured interval when nothing is wrong', () => {
    expect(effectiveCadence(base)).toEqual({
      targetIntervalSeconds: 30,
      effectiveIntervalSeconds: 30,
      reason: null,
    });
  });

  it('backs off further the worse the quota gets', () => {
    const intervals = (['warning', 'high', 'critical'] as const).map(
      (quotaPressure) => effectiveCadence({ ...base, quotaPressure }).effectiveIntervalSeconds,
    );

    expect(intervals).toEqual([60, 120, 240]);
  });

  it('says why, in words an operator can act on', () => {
    expect(effectiveCadence({ ...base, health: 'failing' }).reason).toBe(
      'the connection is failing',
    );
  });

  it('takes the worst cause rather than multiplying them together', () => {
    // A connection that is both rate-limited and unhealthy is one connection in
    // trouble, not two. Compounding would take thirty seconds to twelve minutes
    // and leave it there long after the first cause cleared.
    const both = effectiveCadence({ ...base, quotaPressure: 'high', health: 'degraded' });

    expect(both.effectiveIntervalSeconds).toBe(120);
    expect(both.reason).toBe('the provider quota is running low');
  });

  it('slows down when the previous sweeps have not been worked through', () => {
    const overloaded = effectiveCadence({ ...base, backlog: 400, backlogTolerance: 100 });

    expect(overloaded.effectiveIntervalSeconds).toBe(120);
    expect(overloaded.reason).toContain('400 jobs');
  });

  it('ignores a backlog that is merely the normal amount of work', () => {
    expect(effectiveCadence({ ...base, backlog: 50, backlogTolerance: 100 }).reason).toBeNull();
  });

  it('never goes faster than asked, or slower than the ceiling', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.constantFrom('unknown', 'normal', 'warning', 'high', 'critical'),
        fc.constantFrom('healthy', 'degraded', 'failing', 'unknown'),
        fc.integer({ min: 0, max: 100_000 }),
        (targetIntervalSeconds, quotaPressure, health, backlog) => {
          const cadence = effectiveCadence({
            targetIntervalSeconds,
            quotaPressure,
            health,
            backlog,
          });

          expect(cadence.effectiveIntervalSeconds).toBeGreaterThanOrEqual(
            cadence.targetIntervalSeconds,
          );
          expect(cadence.effectiveIntervalSeconds).toBeLessThanOrEqual(MAX_INTERVAL_SECONDS);
          expect(cadence.targetIntervalSeconds).toBeGreaterThanOrEqual(MIN_INTERVAL_SECONDS);
        },
      ),
    );
  });
});

describe('clampInterval', () => {
  it('holds a request inside section 15 bounds', () => {
    expect(clampInterval(1)).toBe(MIN_INTERVAL_SECONDS);
    expect(clampInterval(99_999)).toBe(MAX_INTERVAL_SECONDS);
    expect(clampInterval(45)).toBe(45);
  });

  it('falls back rather than refusing a value it cannot use', () => {
    // Reached from a settings form and from rows written by earlier versions. A
    // scheduler that threw here would stop sweeping a connection because
    // somebody typed something odd.
    expect(clampInterval(Number.NaN)).toBe(DEFAULT_INTERVAL_SECONDS);
    expect(clampInterval(Number.POSITIVE_INFINITY)).toBe(DEFAULT_INTERVAL_SECONDS);
  });
});

describe('isDue', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');

  it('runs anything that has never run', () => {
    expect(isDue({ lastRunAt: null, intervalMs: 60_000, now })).toBe(true);
  });

  it('waits out the interval', () => {
    expect(
      isDue({
        lastRunAt: new Date(now.getTime() - 30_000),
        intervalMs: 60_000,
        now,
        random: () => 0,
      }),
    ).toBe(false);
  });

  it('only ever fires late, never early', () => {
    // Jitter added rather than subtracted: a sweep that could fire early would
    // drift the whole schedule forwards over a day.
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.999_999, noNaN: true }),
        fc.integer({ min: 0, max: 59_999 }),
        (roll, elapsed) => {
          const lastRunAt = new Date(now.getTime() - elapsed);

          expect(isDue({ lastRunAt, intervalMs: 60_000, now, random: () => roll })).toBe(false);
        },
      ),
    );
  });

  it('fires once enough time has passed for any jitter', () => {
    expect(
      isDue({
        lastRunAt: new Date(now.getTime() - 120_000),
        intervalMs: 60_000,
        now,
        random: () => 0.999,
      }),
    ).toBe(true);
  });
});
