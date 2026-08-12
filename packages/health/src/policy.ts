/**
 * What counts as unwell (sections 22, 23).
 *
 * Every function here is pure, and that is the point rather than a convenience.
 * A threshold is a judgement about when to wake somebody up, and a judgement
 * buried inside a query against a live database is one that gets tested by
 * waiting for the situation to happen in production.
 *
 * Three statuses, not two. `degraded` exists because section 22 is explicit
 * that "failure of an optional or single provider connection degrades that
 * scope rather than taking the entire web application out of readiness", and
 * that "web readiness may remain healthy for inspection while workers are
 * degraded". Collapsing degraded into failing would take the interface away
 * from the operator at the exact moment they need it to find out why.
 */

export type HealthStatus = 'ok' | 'degraded' | 'failing';

export interface HealthCheck {
  readonly name: string;
  readonly status: HealthStatus;
  /** Short and non-sensitive. Never a connection string or a driver message. */
  readonly detail?: string;
  /** What to do about it, when there is something useful to say. */
  readonly remediation?: string;
}

const ORDER: Readonly<Record<HealthStatus, number>> = { ok: 0, degraded: 1, failing: 2 };

/** The worst of several, which is what an overall verdict has to be. */
export function worst(statuses: readonly HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(
    (carried, status) => (ORDER[status] > ORDER[carried] ? status : carried),
    'ok',
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Section 22: "Warn below twenty percent free durable-storage capacity." */
export const DISK_WARNING_FREE_FRACTION = 0.2;
/** Section 22: "Mark Critical below ten percent." */
export const DISK_CRITICAL_FREE_FRACTION = 0.1;
/** Section 22: "Below five percent, pause nonessential ... growth-heavy jobs." */
export const DISK_PAUSE_FREE_FRACTION = 0.05;

/**
 * Where paused work starts again.
 *
 * Higher than the pause threshold on purpose. Section 22 requires hysteresis
 * "to prevent flapping", and without a gap a catalog import that frees nothing
 * would resume the moment a log rotated, fill the disk again, and pause — over
 * and over, at whatever interval the sweep runs, with an alert each time.
 */
export const DISK_RESUME_FREE_FRACTION = 0.08;

/** Section 22: "or when projected exhaustion is within seven days". */
export const PROJECTED_EXHAUSTION_WARNING_DAYS = 7;

export interface DiskReading {
  readonly freeBytes: number;
  readonly totalBytes: number;
  /**
   * Recent growth per day, when it can be measured. Absent on the first
   * reading, and absent is not zero: a projection from one sample is a
   * guess presented as arithmetic.
   */
  readonly dailyGrowthBytes?: number;
}

export interface DiskVerdict {
  readonly status: HealthStatus;
  readonly freeFraction: number;
  /** Whether growth-heavy work should stand down. */
  readonly pauseGrowth: boolean;
  /** Days until the volume is full at the measured rate, when measurable. */
  readonly daysRemaining: number | null;
  readonly detail: string;
}

/**
 * How much room is left, and whether that is a problem.
 *
 * `wasPaused` is passed in rather than derived, because hysteresis is a fact
 * about what happened last time and there is no way to infer it from a single
 * reading. Between the resume and pause thresholds the previous decision
 * stands, which is what stops the flapping.
 */
export function diskVerdict(reading: DiskReading, wasPaused = false): DiskVerdict {
  if (reading.totalBytes <= 0) {
    return {
      status: 'degraded',
      freeFraction: 0,
      pauseGrowth: false,
      daysRemaining: null,
      detail: 'the volume could not be measured',
    };
  }

  const freeFraction = Math.max(0, Math.min(1, reading.freeBytes / reading.totalBytes));
  const percent = (freeFraction * 100).toFixed(1);

  const growth = reading.dailyGrowthBytes;
  const daysRemaining =
    growth === undefined || growth <= 0 ? null : Math.floor(reading.freeBytes / growth);

  const projectedSoon =
    daysRemaining !== null && daysRemaining <= PROJECTED_EXHAUSTION_WARNING_DAYS;

  // Below the pause line, work stops. Above the resume line, it starts again.
  // In between, whatever was decided last time still holds.
  const pauseGrowth =
    freeFraction < DISK_PAUSE_FREE_FRACTION
      ? true
      : freeFraction >= DISK_RESUME_FREE_FRACTION
        ? false
        : wasPaused;

  if (freeFraction < DISK_CRITICAL_FREE_FRACTION) {
    return {
      status: 'failing',
      freeFraction,
      pauseGrowth,
      daysRemaining,
      detail: `${percent}% of the data volume is free`,
    };
  }

  if (freeFraction < DISK_WARNING_FREE_FRACTION || projectedSoon) {
    return {
      status: 'degraded',
      freeFraction,
      pauseGrowth,
      daysRemaining,
      detail: projectedSoon
        ? `${percent}% free, and full in about ${String(daysRemaining)} days at the current rate`
        : `${percent}% of the data volume is free`,
    };
  }

  return {
    status: 'ok',
    freeFraction,
    pauseGrowth,
    daysRemaining,
    detail: `${percent}% of the data volume is free`,
  };
}

// ---------------------------------------------------------------------------
// Liveness of the background tier
// ---------------------------------------------------------------------------

/**
 * How long a heartbeat may be silent before it means something.
 *
 * Generous relative to the beat itself. A worker that missed one beat was busy;
 * a worker that has missed several minutes of them is gone, and the difference
 * matters because the first reading produces an alert nobody can act on.
 */
export const HEARTBEAT_STALE_MS = 90_000;
export const HEARTBEAT_MISSING_MS = 5 * 60_000;

/** Whether something that should be beating still is. */
export function heartbeatVerdict(
  lastSeenAt: Date | null,
  now: Date,
): { readonly status: HealthStatus; readonly detail: string } {
  if (lastSeenAt === null) {
    return { status: 'failing', detail: 'has never reported' };
  }

  const age = now.getTime() - lastSeenAt.getTime();

  if (age >= HEARTBEAT_MISSING_MS) {
    return { status: 'failing', detail: `last seen ${describeAge(age)} ago` };
  }

  if (age >= HEARTBEAT_STALE_MS) {
    return { status: 'degraded', detail: `last seen ${describeAge(age)} ago` };
  }

  return { status: 'ok', detail: `last seen ${describeAge(age)} ago` };
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * When a backlog stops being a backlog and starts being a stall.
 *
 * Age rather than depth is the signal. Ten thousand jobs enqueued a second ago
 * is a busy afternoon; one job enqueued an hour ago is a worker that is not
 * running, and the second is the one worth waking somebody for.
 */
export const QUEUE_SLOW_SECONDS = 5 * 60;
export const QUEUE_STALLED_SECONDS = 30 * 60;

export function queueVerdict(
  oldestAgeSeconds: number | null,
  depth: number,
): { readonly status: HealthStatus; readonly detail: string } {
  if (oldestAgeSeconds === null || depth === 0) {
    return { status: 'ok', detail: 'nothing is waiting' };
  }

  const waiting = `${String(depth)} waiting, oldest ${describeAge(oldestAgeSeconds * 1000)}`;

  if (oldestAgeSeconds >= QUEUE_STALLED_SECONDS) {
    return { status: 'failing', detail: waiting };
  }

  if (oldestAgeSeconds >= QUEUE_SLOW_SECONDS) {
    return { status: 'degraded', detail: waiting };
  }

  return { status: 'ok', detail: waiting };
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * Drift between this process and the database.
 *
 * Worth a check of its own because so much of this application is timestamps
 * compared across two machines: a lease that expires, a token that is valid for
 * ten minutes, a quiet window. A clock an hour out does not look like a clock
 * problem from inside any of those — it looks like every one of them behaving
 * strangely.
 */
export const CLOCK_DRIFT_WARNING_MS = 2_000;
export const CLOCK_DRIFT_FAILING_MS = 30_000;

export function clockVerdict(driftMs: number): {
  readonly status: HealthStatus;
  readonly detail: string;
} {
  const magnitude = Math.abs(driftMs);
  const detail = `${String(Math.round(magnitude))} ms from the database clock`;

  if (magnitude >= CLOCK_DRIFT_FAILING_MS) {
    return { status: 'failing', detail };
  }

  return magnitude >= CLOCK_DRIFT_WARNING_MS
    ? { status: 'degraded', detail }
    : { status: 'ok', detail };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * Section 23 runs backups nightly, so a day and a half of silence is a missed
 * one and three days is a broken schedule rather than a slow night.
 */
export const BACKUP_LATE_MS = 36 * 60 * 60_000;
export const BACKUP_MISSING_MS = 72 * 60 * 60_000;

export function backupVerdict(
  lastSuccessAt: Date | null,
  now: Date,
): { readonly status: HealthStatus; readonly detail: string } {
  if (lastSuccessAt === null) {
    // Not `failing`. A new installation has never taken a backup and is not
    // broken; it is new. What it needs is the sentence, not the alarm.
    return { status: 'degraded', detail: 'no backup has completed yet' };
  }

  const age = now.getTime() - lastSuccessAt.getTime();
  const detail = `last succeeded ${describeAge(age)} ago`;

  if (age >= BACKUP_MISSING_MS) {
    return { status: 'failing', detail };
  }

  return age >= BACKUP_LATE_MS ? { status: 'degraded', detail } : { status: 'ok', detail };
}

/** A duration a person can read, rounded to the unit that is actually useful. */
export function describeAge(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));

  if (seconds < 90) {
    return `${String(seconds)}s`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${String(minutes)}m`;
  }

  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${String(hours)}h` : `${String(Math.round(hours / 24))}d`;
}
