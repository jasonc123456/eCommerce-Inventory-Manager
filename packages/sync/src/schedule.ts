import { connectionHealth, connectionSyncSettings, connections, type Database } from '@eim/db';
import { JobPriority, enqueue } from '@eim/jobs';
import { and, eq, sql } from 'drizzle-orm';

import {
  DEFAULT_INTERVAL_SECONDS,
  clampInterval,
  effectiveCadence,
  isDue,
  type Cadence,
  type ConnectionHealth,
  type QuotaPressure,
} from './cadence';
import { ORDER_POLL_JOB } from './pipeline';

/**
 * Deciding what is due, and queuing it (sections 15, 16).
 *
 * The scheduler is a leader-elected tick that owns no state of its own: every
 * "when did this last run" lives in a row, not in the process. That is what
 * makes a failover invisible — a new leader reads the same rows and reaches the
 * same conclusions, and a restart cannot reset a schedule by forgetting it.
 *
 * It queues work rather than doing it. A tick that swept a connection inline
 * would take as long as the slowest provider and delay every other connection
 * behind it, which is the failure mode a single clock exists to avoid.
 */

export interface SyncSettings {
  readonly connectionId: string;
  readonly businessId: string;
  readonly targetIntervalSeconds: number;
  readonly effectiveIntervalSeconds: number;
  readonly effectiveReason: string | null;
  readonly lastOrderPollAt: Date | null;
  readonly paused: boolean;
  readonly pausedReason: string | null;
}

/** Reads a connection's cadence, creating the default row if it has none. */
export async function readSyncSettings(
  db: Database,
  input: { readonly businessId: string; readonly connectionId: string },
): Promise<SyncSettings> {
  await db
    .insert(connectionSyncSettings)
    .values({ connectionId: input.connectionId, businessId: input.businessId })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(connectionSyncSettings)
    .where(eq(connectionSyncSettings.connectionId, input.connectionId))
    .limit(1);

  if (row === undefined) {
    throw new Error('reading sync settings returned nothing');
  }

  return {
    connectionId: row.connectionId,
    businessId: row.businessId,
    targetIntervalSeconds: row.targetIntervalSeconds,
    effectiveIntervalSeconds: row.effectiveIntervalSeconds,
    effectiveReason: row.effectiveReason,
    lastOrderPollAt: row.lastOrderPollAt,
    paused: row.paused,
    pausedReason: row.pausedReason,
  };
}

export type SetIntervalResult =
  | { readonly outcome: 'set'; readonly seconds: number; readonly clamped: boolean }
  | { readonly outcome: 'not_found' };

/**
 * Changes what an operator is asking for.
 *
 * Reports whether the request was clamped rather than silently applying a
 * different number. Somebody who typed five seconds and got ten should be told
 * so; the alternative is a settings screen that appears to accept a value and
 * then behaves as if it had not.
 */
export async function setTargetInterval(
  db: Database,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly seconds: number;
  },
): Promise<SetIntervalResult> {
  const [connection] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(eq(connections.businessId, input.businessId), eq(connections.id, input.connectionId)),
    )
    .limit(1);

  if (connection === undefined) {
    return { outcome: 'not_found' };
  }

  const seconds = clampInterval(input.seconds);

  await db
    .insert(connectionSyncSettings)
    .values({
      connectionId: input.connectionId,
      businessId: input.businessId,
      targetIntervalSeconds: seconds,
      effectiveIntervalSeconds: seconds,
    })
    .onConflictDoUpdate({
      target: connectionSyncSettings.connectionId,
      set: {
        targetIntervalSeconds: seconds,
        // The effective interval is recomputed on the next tick from live
        // conditions. Raising it to the new target here stops a throttle from
        // an hour ago outlasting the setting it was applied to.
        effectiveIntervalSeconds: sql`greatest(${seconds}, ${connectionSyncSettings.effectiveIntervalSeconds})`,
      },
    });

  return { outcome: 'set', seconds, clamped: seconds !== Math.round(input.seconds) };
}

export interface ScheduleResult {
  readonly cadence: Cadence;
  /** Job kinds queued on this pass. Empty when nothing was due. */
  readonly queued: readonly string[];
  readonly skipped: string | null;
}

/**
 * One connection's turn: work out the cadence, queue whatever is due.
 *
 * The effective cadence is recomputed and stored every pass, not only when it
 * changes. Section 15 requires showing the current effective interval and the
 * reason for any throttling, and a value written only on change is a value that
 * silently ages: an operator looking at "sixty seconds, quota under pressure"
 * has no way to know whether that was decided a minute ago or last Tuesday.
 */
export async function scheduleConnection(
  db: Database,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly now?: Date;
    readonly quotaPressure?: QuotaPressure;
    readonly random?: () => number;
  },
): Promise<ScheduleResult> {
  const now = input.now ?? new Date();
  const settings = await readSyncSettings(db, input);
  const health = await readHealth(db, input.connectionId);
  const backlog = await countBacklog(db, input.connectionId);

  const cadence = effectiveCadence({
    targetIntervalSeconds: settings.targetIntervalSeconds,
    quotaPressure: input.quotaPressure ?? 'unknown',
    health,
    backlog,
  });

  await db
    .update(connectionSyncSettings)
    .set({
      effectiveIntervalSeconds: cadence.effectiveIntervalSeconds,
      effectiveReason: cadence.reason,
    })
    .where(eq(connectionSyncSettings.connectionId, input.connectionId));

  if (settings.paused) {
    return {
      cadence,
      queued: [],
      skipped: settings.pausedReason ?? 'synchronization is paused for this connection',
    };
  }

  const queued: string[] = [];

  const orderPollDue = isDue({
    lastRunAt: settings.lastOrderPollAt,
    intervalMs: cadence.effectiveIntervalSeconds * 1000,
    now,
    ...(input.random === undefined ? {} : { random: input.random }),
  });

  if (orderPollDue) {
    await enqueue(db, {
      kind: ORDER_POLL_JOB,
      businessId: input.businessId,
      connectionId: input.connectionId,
      priority: JobPriority.orderIngestion,
      // One poll per connection at a time. A second queued behind the first
      // would sweep an overlapping window for no gain.
      dedupeKey: `poll:${input.connectionId}`,
      serializationKey: `poll:${input.connectionId}`,
      payload: {},
    });

    await db
      .update(connectionSyncSettings)
      .set({ lastOrderPollAt: now })
      .where(eq(connectionSyncSettings.connectionId, input.connectionId));

    queued.push(ORDER_POLL_JOB);
  }

  return { cadence, queued, skipped: null };
}

/**
 * Every connection the scheduler should be looking after.
 *
 * Active only. A paused, disconnected, or revoked connection is one somebody
 * has decided to stop talking to, and continuing to queue work for it would
 * spend quota on an account that may already have revoked us.
 */
export async function schedulableConnections(
  db: Database,
): Promise<readonly { readonly businessId: string; readonly connectionId: string }[]> {
  const rows = await db
    .select({ businessId: connections.businessId, connectionId: connections.id })
    .from(connections)
    .where(eq(connections.status, 'active'));

  return rows;
}

/** Pauses or resumes sweeping one connection, without touching its settings. */
export async function setSyncPaused(
  db: Database,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly paused: boolean;
    readonly reason?: string;
  },
): Promise<void> {
  await db
    .insert(connectionSyncSettings)
    .values({
      connectionId: input.connectionId,
      businessId: input.businessId,
      targetIntervalSeconds: DEFAULT_INTERVAL_SECONDS,
      effectiveIntervalSeconds: DEFAULT_INTERVAL_SECONDS,
      paused: input.paused,
      ...(input.reason === undefined ? {} : { pausedReason: input.reason }),
    })
    .onConflictDoUpdate({
      target: connectionSyncSettings.connectionId,
      set: { paused: input.paused, pausedReason: input.reason ?? null },
    });
}

async function readHealth(db: Database, connectionId: string): Promise<ConnectionHealth> {
  const [row] = await db
    .select({ status: connectionHealth.status })
    .from(connectionHealth)
    .where(eq(connectionHealth.connectionId, connectionId))
    .limit(1);

  return row?.status ?? 'unknown';
}

/**
 * How much is already waiting for this connection.
 *
 * Counts ready jobs rather than all unfinished ones: a job that is running is
 * being dealt with, and counting it would throttle a connection for being busy
 * rather than for being behind.
 */
async function countBacklog(db: Database, connectionId: string): Promise<number> {
  const rows = await db.execute<{ count: string }>(sql`
    select count(*)::text as count
      from background_jobs
     where connection_id = ${connectionId}::uuid and status = 'ready'
  `);

  return Number(rows.rows[0]?.count ?? '0');
}
