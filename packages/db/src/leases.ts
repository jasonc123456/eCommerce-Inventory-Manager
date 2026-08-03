import { sql } from 'drizzle-orm';

import type { Database } from './client';

/**
 * Leader election by time-limited lease (sections 15, 16).
 *
 * Exactly one worker replica owns the projection clock. The rule the whole
 * design rests on is that the lease is granted by the database's clock, never
 * by any process's own, because the failure being guarded against is precisely
 * a process whose sense of time or liveness has become unreliable.
 *
 * Both operations below are a single statement. That is not an optimization: a
 * read-then-write would leave a window in which two candidates both saw an
 * expired lease and both claimed it, which is the exact outcome leader election
 * exists to prevent. `where` clauses evaluated inside one atomic upsert close
 * that window without needing an explicit transaction or a lock.
 */

export interface LeaseHolder {
  readonly holderId: string;
  readonly appVersion?: string;
}

export interface LeaseState {
  readonly holderId: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
  readonly lastHeartbeat: Date;
}

/**
 * Claims the scheduler lease, or confirms this process already holds it.
 *
 * Returns null when another live process holds it, which is the ordinary case
 * for every replica but one and is not an error.
 *
 * The lease duration wants to be several times the renewal interval. Too short
 * and a garbage-collection pause hands the clock to somebody else; too long and
 * a genuinely dead scheduler stalls the cadence until it expires.
 */
export async function acquireSchedulerLease(
  db: Database,
  holder: LeaseHolder,
  leaseDurationMs: number,
): Promise<LeaseState | null> {
  const rows = await db.execute<{
    holder_id: string;
    acquired_at: Date | string;
    expires_at: Date | string;
    last_heartbeat: Date | string;
  }>(sql`
    insert into scheduler_leases (role, holder_id, expires_at, app_version)
    values (
      'scheduler',
      ${holder.holderId}::uuid,
      now() + make_interval(secs => ${leaseDurationMs / 1000}),
      ${holder.appVersion ?? null}
    )
    on conflict (role) do update
       set holder_id   = excluded.holder_id,
           expires_at  = excluded.expires_at,
           app_version = excluded.app_version,
           last_heartbeat = now(),
           -- Only reset the acquisition time on an actual change of holder, so
           -- "leader since" stays meaningful across renewals.
           acquired_at = case
             when scheduler_leases.holder_id = excluded.holder_id
               then scheduler_leases.acquired_at
             else now()
           end
     where scheduler_leases.expires_at < now()
        or scheduler_leases.holder_id = excluded.holder_id
    returning holder_id, acquired_at, expires_at, last_heartbeat
  `);

  const row = rows.rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    holderId: row.holder_id,
    acquiredAt: toDate(row.acquired_at),
    expiresAt: toDate(row.expires_at),
    lastHeartbeat: toDate(row.last_heartbeat),
  };
}

/**
 * Extends a lease this process already holds.
 *
 * Returns false when the lease has been lost, which happens when renewal was
 * late enough for another process to take it. A scheduler that gets false here
 * must stop scheduling immediately and go back to contending: continuing would
 * mean two processes driving one clock, which is the situation this whole
 * mechanism exists to avoid.
 */
export async function renewSchedulerLease(
  db: Database,
  holder: LeaseHolder,
  leaseDurationMs: number,
): Promise<boolean> {
  const rows = await db.execute<{ holder_id: string }>(sql`
    update scheduler_leases
       set expires_at = now() + make_interval(secs => ${leaseDurationMs / 1000}),
           last_heartbeat = now()
     where role = 'scheduler'
       and holder_id = ${holder.holderId}::uuid
       and expires_at > now()
    returning holder_id
  `);

  return rows.rows.length === 1;
}

/**
 * Gives up the lease deliberately.
 *
 * Called on graceful shutdown so a rolling deployment hands over in
 * milliseconds rather than waiting for expiry. Failing to release is safe; it
 * just costs one lease duration of stalled cadence.
 */
export async function releaseSchedulerLease(db: Database, holder: LeaseHolder): Promise<void> {
  await db.execute(sql`
    delete from scheduler_leases
     where role = 'scheduler' and holder_id = ${holder.holderId}::uuid
  `);
}

/**
 * Normalizes a timestamp from a raw `execute`.
 *
 * Drizzle's typed query builder applies the column mappings declared in the
 * schema, but `execute` runs raw SQL and hands back whatever the driver
 * produced, which for a timestamptz may be a string. Coercing here rather than
 * at each call site keeps the LeaseState contract honest: callers are promised
 * a Date and get one.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The lease as it stands, for the health endpoint. */
export async function readSchedulerLease(db: Database): Promise<LeaseState | null> {
  const rows = await db.execute<{
    holder_id: string;
    acquired_at: Date | string;
    expires_at: Date | string;
    last_heartbeat: Date | string;
  }>(sql`
    select holder_id, acquired_at, expires_at, last_heartbeat
      from scheduler_leases
     where role = 'scheduler'
  `);

  const row = rows.rows[0];
  return row === undefined
    ? null
    : {
        holderId: row.holder_id,
        acquiredAt: toDate(row.acquired_at),
        expiresAt: toDate(row.expires_at),
        lastHeartbeat: toDate(row.last_heartbeat),
      };
}

/** Records that a background process is alive. */
export async function recordHeartbeat(
  db: Database,
  worker: { readonly workerId: string; readonly role: 'worker' | 'scheduler' },
  activeJobs: number,
  appVersion?: string,
): Promise<void> {
  await db.execute(sql`
    insert into worker_heartbeats (worker_id, role, active_jobs, app_version)
    values (${worker.workerId}::uuid, ${worker.role}, ${activeJobs}, ${appVersion ?? null})
    on conflict (worker_id) do update
       set last_seen_at = now(),
           role         = excluded.role,
           active_jobs  = excluded.active_jobs,
           app_version  = excluded.app_version
  `);
}

/** Removes heartbeats older than the cutoff, so a dead replica stops counting. */
export async function pruneHeartbeats(db: Database, olderThanMs: number): Promise<number> {
  const rows = await db.execute<{ worker_id: string }>(sql`
    delete from worker_heartbeats
     where last_seen_at < now() - make_interval(secs => ${olderThanMs / 1000})
    returning worker_id
  `);

  return rows.rows.length;
}
