import { describe, expect, it } from 'vitest';

import { isQuietAt, localMinutesOfDay, minutesOfDay, quietUntil } from './quiet-hours';

/**
 * Quiet hours (sections 9, 22).
 *
 * Two things are worth proving and neither is obvious. A window that wraps
 * midnight is the normal case, not an edge one — nobody's quiet hours run from
 * nine in the morning to five in the afternoon. And the zone is the shop's, so
 * the same instant is quiet in Auckland and loud in London.
 */

const LONDON = 'Europe/London';
const AUCKLAND = 'Pacific/Auckland';

describe('minutesOfDay', () => {
  it('reads both the shapes PostgreSQL hands back for a time column', () => {
    expect(minutesOfDay('21:00')).toBe(21 * 60);
    expect(minutesOfDay('21:00:00')).toBe(21 * 60);
    expect(minutesOfDay(' 07:30 ')).toBe(7 * 60 + 30);
  });

  it('refuses anything that is not a wall clock', () => {
    expect(minutesOfDay('')).toBeNull();
    expect(minutesOfDay('midnight')).toBeNull();
    expect(minutesOfDay('24:00')).toBeNull();
    expect(minutesOfDay('21:60')).toBeNull();
  });
});

describe('localMinutesOfDay', () => {
  it('answers in the shop the question is about', () => {
    // 2026-06-01T09:00Z is 10:00 in London (summer time) and 21:00 in Auckland.
    const instant = new Date('2026-06-01T09:00:00.000Z');

    expect(localMinutesOfDay(instant, LONDON)).toBe(10 * 60);
    expect(localMinutesOfDay(instant, AUCKLAND)).toBe(21 * 60);
    expect(localMinutesOfDay(instant, 'UTC')).toBe(9 * 60);
  });

  it('says it does not know rather than guessing at UTC', () => {
    // Falling back would move every quiet hour by up to half a day, quietly.
    expect(localMinutesOfDay(new Date(), 'Mars/Olympus_Mons')).toBeNull();
  });
});

describe('isQuietAt', () => {
  const night = { start: '21:00', end: '07:00', timeZone: LONDON };

  it('covers a window that wraps midnight', () => {
    expect(isQuietAt(new Date('2026-01-15T22:30:00.000Z'), night)).toBe(true);
    expect(isQuietAt(new Date('2026-01-15T03:00:00.000Z'), night)).toBe(true);
    expect(isQuietAt(new Date('2026-01-15T12:00:00.000Z'), night)).toBe(false);
  });

  it('is exclusive at the end, so a window and its complement do not overlap', () => {
    expect(isQuietAt(new Date('2026-01-15T21:00:00.000Z'), night)).toBe(true);
    expect(isQuietAt(new Date('2026-01-15T07:00:00.000Z'), night)).toBe(false);
  });

  it('covers a window inside one day', () => {
    const lunch = { start: '12:00', end: '13:00', timeZone: 'UTC' };

    expect(isQuietAt(new Date('2026-01-15T12:30:00.000Z'), lunch)).toBe(true);
    expect(isQuietAt(new Date('2026-01-15T13:30:00.000Z'), lunch)).toBe(false);
  });

  it('survives a daylight-saving change, which is why the zone is stored', () => {
    // 22:30 local on both sides of the spring transition. The instants differ
    // by an hour of UTC; the shop's evening does not.
    expect(isQuietAt(new Date('2026-01-15T22:30:00.000Z'), night)).toBe(true);
    expect(isQuietAt(new Date('2026-06-15T21:30:00.000Z'), night)).toBe(true);
  });

  it('is never quiet when the window cannot be understood', () => {
    expect(isQuietAt(new Date(), { start: 'nine', end: '07:00', timeZone: LONDON })).toBe(false);
    expect(isQuietAt(new Date(), { start: '21:00', end: 'seven', timeZone: LONDON })).toBe(false);
    expect(isQuietAt(new Date(), { start: '21:00', end: '21:00', timeZone: LONDON })).toBe(false);
    expect(isQuietAt(new Date(), { start: '21:00', end: '07:00', timeZone: 'Nowhere' })).toBe(
      false,
    );
  });
});

describe('quietUntil', () => {
  const night = { start: '21:00', end: '07:00', timeZone: 'UTC' };

  it('waits until the shop opens, across midnight', () => {
    const at = new Date('2026-01-15T22:30:00.000Z');

    expect(quietUntil(at, night)?.toISOString()).toBe('2026-01-16T07:00:00.000Z');
  });

  it('waits only the remainder when the night is nearly over', () => {
    const at = new Date('2026-01-15T06:30:00.000Z');

    expect(quietUntil(at, night)?.toISOString()).toBe('2026-01-15T07:00:00.000Z');
  });

  it('has nothing to wait for outside the window', () => {
    expect(quietUntil(new Date('2026-01-15T12:00:00.000Z'), night)).toBeNull();
  });

  it('has nothing to wait for when the window cannot be understood', () => {
    expect(quietUntil(new Date(), { start: '21:00', end: 'seven', timeZone: 'UTC' })).toBeNull();
  });
});
