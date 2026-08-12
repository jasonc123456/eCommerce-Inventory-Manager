/**
 * When the shop would rather not be woken up (sections 9, 22).
 *
 * Quiet hours are stored as two local wall-clock times and interpreted in the
 * business's own timezone. That is deliberately harder than storing an offset,
 * and the reason is daylight saving: "we are shut after nine" is still true in
 * March, and a stored offset silently becomes "after eight" for half the year.
 *
 * The window may wrap past midnight, which is the normal case — 21:00 to 07:00
 * is a night, not an empty set — so the containment test is written for both
 * shapes rather than assuming start is before end.
 */

export interface QuietHours {
  /** Local wall clock, `HH:MM` or `HH:MM:SS`. */
  readonly start: string;
  readonly end: string;
  /** An IANA zone name. `businesses.timezone` holds one, defaulting to UTC. */
  readonly timeZone: string;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Minutes since local midnight, or null if the text is not a wall-clock time.
 *
 * Split rather than matched. PostgreSQL hands back `21:00:00` for a `time`
 * column while a form field submits `21:00`, so both shapes have to be read,
 * and a regular expression with an optional trailing group for that is the kind
 * a linter is right to be suspicious of. Splitting on the colon says the same
 * thing with nothing to backtrack over.
 */
export function minutesOfDay(wallClock: string): number | null {
  const parts = wallClock.trim().split(':');

  if (parts.length < 2 || parts.length > 3) {
    return null;
  }

  const hours = wholeNumber(parts[0]);
  const minutes = wholeNumber(parts[1]);

  if (hours === null || minutes === null || hours > 23 || minutes > 59) {
    return null;
  }

  // Seconds are read only to be rejected when they are nonsense. Nothing rounds
  // to the minute here, because a quiet window has never been set to the second.
  if (parts.length === 3 && wholeNumber(parts[2]) === null) {
    return null;
  }

  return hours * 60 + minutes;
}

/** One or two digits, and nothing else. `Number('')` is zero, which is not. */
function wholeNumber(text: string | undefined): number | null {
  if (text === undefined || text.length === 0 || text.length > 2) {
    return null;
  }

  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * What time it is where the shop is.
 *
 * `Intl` rather than arithmetic on the epoch, because the offset for a zone on
 * a given instant is a lookup in the timezone database and not something that
 * can be derived. An unknown zone name throws, and this returns null rather
 * than falling back to UTC: silently treating Auckland as London would move
 * every quiet hour by half a day.
 */
export function localMinutesOfDay(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);

    const hour = parts.find((part) => part.type === 'hour')?.value;
    const minute = parts.find((part) => part.type === 'minute')?.value;

    if (hour === undefined || minute === undefined) {
      return null;
    }

    return Number(hour) * 60 + Number(minute);
  } catch {
    return null;
  }
}

/** Whether `now` falls inside the window, including a window that wraps midnight. */
export function isQuietAt(now: Date, quietHours: QuietHours): boolean {
  const start = minutesOfDay(quietHours.start);
  const end = minutesOfDay(quietHours.end);
  const current = localMinutesOfDay(now, quietHours.timeZone);

  if (start === null || end === null || current === null || start === end) {
    return false;
  }

  return start < end
    ? current >= start && current < end
    : // Wraps midnight: quiet is everything after the start or before the end.
      current >= start || current < end;
}

/**
 * When the quiet window ends, as an instant.
 *
 * Computed by adding the remaining minutes to `now` rather than by constructing
 * a local date, so it needs no calendar arithmetic in a foreign zone. A
 * transition inside the window can move the true end by an hour; the sweep that
 * sends deferred notifications re-checks `isQuietAt` when it wakes, so the
 * consequence is one extra pass rather than a message sent in the quiet.
 */
export function quietUntil(now: Date, quietHours: QuietHours): Date | null {
  if (!isQuietAt(now, quietHours)) {
    return null;
  }

  const end = minutesOfDay(quietHours.end);
  const current = localMinutesOfDay(now, quietHours.timeZone);

  if (end === null || current === null) {
    return null;
  }

  const remaining = (end - current + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return new Date(now.getTime() + remaining * 60_000);
}
