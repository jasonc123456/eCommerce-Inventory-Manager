import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@eim/db';

import {
  DEAD_LETTER_WINDOW_MS,
  MAX_ATTEMPTS,
  nextAttempt,
  type DeadLetterReason,
  type RetryDecision,
} from './retry';

/**
 * Enqueuing, claiming, and finishing durable jobs (sections 12, 15).
 *
 * Every operation here is a single statement wherever a read-then-write would
 * leave a window. That is the same reasoning as the scheduler lease: two
 * workers that both read "ready" and both write "running" have both claimed one
 * job, and no amount of application-side care closes a gap the database can
 * close atomically.
 *
 * The one place a transaction is used instead is the claim, because claiming
 * also opens an attempt record, and a job that is running with no attempt row
 * would be invisible to the operator asking what a worker is doing.
 */

/**
 * Section 12's priority ordering, as numbers so the queue can sort by it.
 *
 * "Order ingestion and inventory writes take priority over imports,
 * reconciliation, prices, drafts, AI, and reporting." Spaced by ten so a class
 * can be inserted between two later without renumbering rows already in flight.
 */
export const JobPriority = {
  /** A customer bought something. Nothing waits in front of this. */
  orderIngestion: 10,
  /** Protecting a channel from overselling what is no longer there. */
  protectiveWrite: 20,
  /** An ordinary quantity projection, including increases. */
  inventoryWrite: 30,
  /** Reading back what a write actually did. */
  verification: 40,
  reconciliation: 50,
  imports: 60,
  reporting: 70,
} as const;

export type JobPriorityName = keyof typeof JobPriority;

export interface EnqueueInput {
  readonly kind: string;
  readonly businessId?: string | null;
  readonly connectionId?: string | null;
  readonly priority?: number;
  /** The scope this job must run alone within. Section 12's per-mapping serialization. */
  readonly serializationKey?: string;
  /** Collapses repeated wake-ups for one entity into one pending job. */
  readonly dedupeKey?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
  /** How long this job may keep trying. Defaults to section 12's 24 hours. */
  readonly windowMs?: number;
}

export interface QueuedJob {
  readonly id: string;
  readonly businessId: string | null;
  readonly connectionId: string | null;
  readonly kind: string;
  readonly priority: number;
  readonly serializationKey: string | null;
  readonly dedupeKey: string | null;
  readonly payload: Record<string, unknown>;
  readonly status: 'ready' | 'running' | 'succeeded' | 'dead' | 'cancelled';
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: Date;
  readonly expiresAt: Date;
  readonly lastFailureKind: string | null;
  readonly lastError: string | null;
}

export interface EnqueueResult {
  readonly job: QueuedJob;
  /**
   * True when an equivalent job was already pending and this call added
   * nothing. Section 15 wants repeated wake-ups coalesced, so this is the
   * ordinary case under load rather than a problem.
   */
  readonly deduplicated: boolean;
}

/** A minimal database surface, so callers can enqueue inside their own transaction. */
export type QueueExecutor = Pick<Database, 'execute'>;

/**
 * Adds a job.
 *
 * Call this inside the transaction that caused it. That is what makes the
 * queue a transactional outbox rather than a queue next to one: the job becomes
 * visible exactly when its cause commits, and a rollback takes it with it.
 */
export async function enqueue(db: QueueExecutor, input: EnqueueInput): Promise<EnqueueResult> {
  const windowMs = input.windowMs ?? DEAD_LETTER_WINDOW_MS;

  const inserted = await db.execute<JobRow>(sql`
    insert into background_jobs (
      business_id, connection_id, kind, priority, serialization_key, dedupe_key,
      payload, run_at, expires_at, max_attempts
    )
    values (
      ${input.businessId ?? null}, ${input.connectionId ?? null}, ${input.kind},
      ${input.priority ?? JobPriority.reconciliation},
      ${input.serializationKey ?? null}, ${input.dedupeKey ?? null},
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      coalesce(${input.runAt ?? null}::timestamptz, now()),
      coalesce(${input.runAt ?? null}::timestamptz, now()) + make_interval(secs => ${windowMs / 1000}),
      ${input.maxAttempts ?? MAX_ATTEMPTS}
    )
    -- Matches the partial unique index exactly, so the coalescing rule is the
    -- index's rather than this statement's opinion of it.
    on conflict (dedupe_key) where status in ('ready', 'running') and dedupe_key is not null
      do nothing
    returning ${jobColumns}
  `);

  const row = inserted.rows[0];
  if (row !== undefined) {
    return { job: toJob(row), deduplicated: false };
  }

  // The insert was swallowed by the dedupe index. Return the job that won,
  // because the caller usually wants its id to reference from an audit record.
  const existing = await db.execute<JobRow>(sql`
    select ${jobColumns} from background_jobs
     where dedupe_key = ${input.dedupeKey ?? null}
       and status in ('ready', 'running')
     limit 1
  `);

  const winner = existing.rows[0];
  if (winner === undefined) {
    // It finished between the two statements, so nothing is pending and the
    // caller's intent would be lost. Insert again without the dedupe key
    // contest; a second insert here is a new wake-up, not a duplicate.
    const { dedupeKey: _contested, ...retry } = input;

    return enqueue(db, retry);
  }

  return { job: toJob(winner), deduplicated: true };
}

export interface ClaimOptions {
  readonly workerId: string;
  /** How long the claim survives without a heartbeat. */
  readonly leaseMs: number;
  /** Restrict to these kinds. Empty or absent means any kind. */
  readonly kinds?: readonly string[];
  /** Restrict to jobs at least this urgent. Used to keep a lane for order work. */
  readonly maxPriority?: number;
}

export interface ClaimedJob extends QueuedJob {
  readonly attemptId: string;
  readonly workerId: string;
}

/**
 * Takes one job, or returns null when there is nothing to do.
 *
 * `for update skip locked` is what lets many workers share one queue without
 * coordinating: each skips rows another has locked rather than waiting behind
 * them, so the slowest job never becomes everybody's head-of-line.
 *
 * The `not exists` clause implements section 12's per-mapping serialization,
 * and is deliberately not the only thing enforcing it. Two workers can both
 * evaluate it against a moment when neither had yet written `running`; the
 * partial unique index catches that, this function sees the violation, and
 * tries again for a different job. Relying on the query alone would be a race
 * that appears only under the load it matters most under.
 */
export async function claim(db: Database, options: ClaimOptions): Promise<ClaimedJob | null> {
  for (let contest = 0; contest < CLAIM_CONTEST_LIMIT; contest += 1) {
    try {
      return await claimOnce(db, options);
    } catch (error) {
      if (isSerializationKeyContest(error)) {
        continue;
      }
      throw error;
    }
  }

  // Every attempt lost the same contest. Not an error: it means another worker
  // is already doing the serialized work, which is the outcome we wanted.
  return null;
}

const CLAIM_CONTEST_LIMIT = 5;

async function claimOnce(db: Database, options: ClaimOptions): Promise<ClaimedJob | null> {
  return db.transaction(async (tx) => {
    const kinds = options.kinds ?? [];

    const claimed = await tx.execute<JobRow>(sql`
      update background_jobs
         set status = 'running',
             attempts = background_jobs.attempts + 1,
             claimed_by = ${options.workerId}::uuid,
             claimed_at = now(),
             claim_lease_expires_at = now() + make_interval(secs => ${options.leaseMs / 1000})
       where id = (
         select candidate.id
           from background_jobs candidate
          where candidate.status = 'ready'
            and candidate.run_at <= now()
            and candidate.expires_at > now()
            and candidate.attempts < candidate.max_attempts
            ${
              kinds.length === 0
                ? sql``
                : // `sql.param` rather than interpolating the array directly:
                  // the template flattens an array into one placeholder per
                  // element, which is a list of scalars where `any` wants one
                  // array value.
                  sql`and candidate.kind = any(${sql.param([...kinds])}::text[])`
            }
            ${options.maxPriority === undefined ? sql`` : sql`and candidate.priority <= ${options.maxPriority}`}
            and (
              candidate.serialization_key is null
              or not exists (
                select 1 from background_jobs running
                 where running.serialization_key = candidate.serialization_key
                   and running.status = 'running'
              )
            )
          order by candidate.priority, candidate.run_at, candidate.created_at
          for update skip locked
          limit 1
       )
      returning ${jobColumns}
    `);

    const row = claimed.rows[0];
    if (row === undefined) {
      return null;
    }

    // Numbered by the claims that have happened, not by the job's attempt
    // counter. The two legitimately diverge: a claim released on shutdown or
    // reclaimed after a crash refunds the retry but still happened, and an
    // operator replay resets the counter without erasing what came before. The
    // attempt record answers "what has this job been through", which needs to
    // keep counting when the retry budget does not.
    const attempt = await tx.execute<{ id: string }>(sql`
      insert into background_job_attempts (job_id, attempt, worker_id)
      select ${row.id}::uuid,
             coalesce(max(a.attempt), 0) + 1,
             ${options.workerId}::uuid
        from background_job_attempts a
       where a.job_id = ${row.id}::uuid
      returning id
    `);

    const attemptId = attempt.rows[0]?.id;
    if (attemptId === undefined) {
      throw new Error('claimed a job but could not open an attempt record');
    }

    return { ...toJob(row), attemptId, workerId: options.workerId };
  });
}

/** Extends a claim while the job is still being worked on. */
export async function heartbeat(
  db: QueueExecutor,
  job: { readonly id: string; readonly workerId: string },
  leaseMs: number,
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    update background_jobs
       set claim_lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000})
     where id = ${job.id}::uuid
       and status = 'running'
       and claimed_by = ${job.workerId}::uuid
    returning id
  `);

  return rows.rows.length === 1;
}

export async function succeed(
  db: QueueExecutor,
  job: { readonly id: string; readonly attemptId: string },
): Promise<void> {
  await db.execute(sql`
    update background_jobs
       set status = 'succeeded',
           claimed_by = null,
           claimed_at = null,
           claim_lease_expires_at = null,
           finished_at = now(),
           last_failure_kind = null,
           last_error = null
     where id = ${job.id}::uuid
  `);

  await db.execute(sql`
    update background_job_attempts
       set outcome = 'succeeded', finished_at = now()
     where id = ${job.attemptId}::uuid
  `);
}

/**
 * Records that this job's work is no longer wanted.
 *
 * Section 12: "superseded jobs are skipped". A newer desired target makes an
 * older one wrong, not merely late, so the older job ends without an attempt
 * against the provider and without counting as a failure.
 */
export async function supersede(
  db: QueueExecutor,
  job: { readonly id: string; readonly attemptId?: string },
  detail: string,
): Promise<void> {
  await db.execute(sql`
    update background_jobs
       set status = 'cancelled',
           claimed_by = null,
           claimed_at = null,
           claim_lease_expires_at = null,
           finished_at = now(),
           last_error = ${detail}
     where id = ${job.id}::uuid
       and status in ('ready', 'running')
  `);

  if (job.attemptId !== undefined) {
    await db.execute(sql`
      update background_job_attempts
         set outcome = 'superseded', finished_at = now(), detail = ${detail}
       where id = ${job.attemptId}::uuid
    `);
  }
}

export interface FailureInput {
  readonly job: ClaimedJob;
  readonly failureKind: string;
  readonly detail: string;
  /** Whether repeating the same call unchanged could succeed. */
  readonly retryable: boolean;
  /** What the provider asked for, when it asked. */
  readonly retryAfterMs?: number;
  readonly now?: Date;
  readonly random?: () => number;
}

export type FailureOutcome =
  | { readonly outcome: 'retry'; readonly runAt: Date }
  | { readonly outcome: 'dead_letter'; readonly reason: DeadLetterReason };

/**
 * Records a failed attempt and decides what happens next.
 *
 * The decision is taken in application code rather than in SQL because it is
 * the part a person has to reason about — and because `nextAttempt` being pure
 * is what allows the ten-attempt and 24-hour rules to be tested as properties
 * instead of by waiting a day.
 */
export async function fail(db: QueueExecutor, input: FailureInput): Promise<FailureOutcome> {
  const now = input.now ?? new Date();

  const decision: RetryDecision = nextAttempt({
    attempt: input.job.attempts,
    maxAttempts: input.job.maxAttempts,
    now,
    expiresAt: input.job.expiresAt,
    retryable: input.retryable,
    ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
    ...(input.random === undefined ? {} : { random: input.random }),
  });

  if (decision.decision === 'dead_letter') {
    await db.execute(sql`
      update background_jobs
         set status = 'dead',
             claimed_by = null,
             claimed_at = null,
             claim_lease_expires_at = null,
             finished_at = now(),
             last_failure_kind = ${input.failureKind},
             last_error = ${input.detail}
       where id = ${input.job.id}::uuid
    `);

    await db.execute(sql`
      update background_job_attempts
         set outcome = 'failed',
             finished_at = now(),
             failure_kind = ${input.failureKind},
             detail = ${`${input.detail} (dead-lettered: ${decision.reason})`},
             retry_after_ms = ${input.retryAfterMs ?? null}
       where id = ${input.job.attemptId}::uuid
    `);

    return { outcome: 'dead_letter', reason: decision.reason };
  }

  await db.execute(sql`
    update background_jobs
       set status = 'ready',
           run_at = ${decision.runAt},
           claimed_by = null,
           claimed_at = null,
           claim_lease_expires_at = null,
           last_failure_kind = ${input.failureKind},
           last_error = ${input.detail}
     where id = ${input.job.id}::uuid
  `);

  await db.execute(sql`
    update background_job_attempts
       set outcome = 'failed',
           finished_at = now(),
           failure_kind = ${input.failureKind},
           detail = ${input.detail},
           retry_after_ms = ${input.retryAfterMs ?? null},
           next_run_at = ${decision.runAt}
     where id = ${input.job.attemptId}::uuid
  `);

  return { outcome: 'retry', runAt: decision.runAt };
}

/**
 * Returns jobs whose worker stopped heartbeating.
 *
 * Section 12: "PostgreSQL leases and heartbeats make worker jobs reclaimable
 * after crashes." The attempt is already spent — the job may well have reached
 * the provider before the process died — so this restores the job to ready
 * without refunding the attempt, and lets the outcome-lookup rule in section 12
 * deal with whether the work actually happened.
 */
export async function reclaimExpired(db: QueueExecutor): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    with expired as (
      select id, attempts from background_jobs
       where status = 'running' and claim_lease_expires_at < now()
       for update skip locked
    ),
    reopened as (
      update background_jobs j
         set status = case when j.attempts >= j.max_attempts then 'dead' else 'ready' end,
             claimed_by = null,
             claimed_at = null,
             claim_lease_expires_at = null,
             last_failure_kind = 'worker_lost',
             last_error = 'the worker holding this job stopped reporting',
             finished_at = case when j.attempts >= j.max_attempts then now() else null end
        from expired
       where j.id = expired.id
      returning j.id
    )
    -- Closed by being the claim still open, not by its number: attempt numbers
    -- count claims and the job's counter counts retries, so the two are not
    -- interchangeable.
    update background_job_attempts a
       set outcome = 'reclaimed', finished_at = now()
      from reopened
     where a.job_id = reopened.id and a.outcome is null
    returning a.job_id as id
  `);

  return rows.rows.length;
}

/**
 * Dead-letters jobs whose window elapsed while nothing was running.
 *
 * The 24-hour outage case: the process was down, so no attempt failed and no
 * retry decision was ever taken, but the deadline passed all the same. Without
 * this sweep those jobs would come back as ready and attempt work whose moment
 * has gone.
 */
export async function expireOverdue(db: QueueExecutor): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    update background_jobs
       set status = 'dead',
           finished_at = now(),
           last_failure_kind = 'window_elapsed',
           last_error = 'the 24-hour window elapsed before this job could run'
     where status = 'ready' and expires_at <= now()
    returning id
  `);

  return rows.rows.length;
}

/** Hands a claimed job back untouched, for graceful shutdown. */
export async function release(
  db: QueueExecutor,
  job: { readonly id: string; readonly attemptId: string; readonly workerId: string },
): Promise<void> {
  await db.execute(sql`
    update background_jobs
       set status = 'ready',
           attempts = greatest(0, attempts - 1),
           claimed_by = null,
           claimed_at = null,
           claim_lease_expires_at = null
     where id = ${job.id}::uuid and claimed_by = ${job.workerId}::uuid and status = 'running'
  `);

  await db.execute(sql`
    update background_job_attempts
       set outcome = 'reclaimed', finished_at = now(), detail = 'released on shutdown'
     where id = ${job.attemptId}::uuid
  `);
}

/** The dead-letter queue, for the operator screen and for replay. */
export async function listDeadLettered(
  db: QueueExecutor,
  businessId: string,
  limit = 50,
): Promise<readonly QueuedJob[]> {
  const rows = await db.execute<JobRow>(sql`
    select ${jobColumns} from background_jobs
     where business_id = ${businessId}::uuid and status = 'dead'
     order by finished_at desc
     limit ${limit}
  `);

  return rows.rows.map(toJob);
}

/**
 * Puts a dead-lettered job back in the queue with a fresh window.
 *
 * Section 12 as amended by D-139: "operators can replay a dead-lettered job
 * once the provider's stated delay has elapsed." The attempt count resets
 * because the operator has taken responsibility for the decision; the original
 * attempts remain in the attempt history, so nothing is hidden.
 */
export async function replay(
  db: QueueExecutor,
  jobId: string,
  windowMs = DEAD_LETTER_WINDOW_MS,
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    update background_jobs
       set status = 'ready',
           attempts = 0,
           run_at = now(),
           expires_at = now() + make_interval(secs => ${windowMs / 1000}),
           finished_at = null
     where id = ${jobId}::uuid and status = 'dead'
    returning id
  `);

  return rows.rows.length === 1;
}

const jobColumns: SQL = sql`
  id, business_id, connection_id, kind, priority, serialization_key, dedupe_key,
  payload, status, attempts, max_attempts, run_at, expires_at,
  last_failure_kind, last_error
`;

/**
 * Extends `Record<string, unknown>` because that is what `execute` constrains
 * its row type to, and a plain interface has no index signature to satisfy it.
 */
interface JobRow extends Record<string, unknown> {
  id: string;
  business_id: string | null;
  connection_id: string | null;
  kind: string;
  priority: number;
  serialization_key: string | null;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  status: QueuedJob['status'];
  attempts: number;
  max_attempts: number;
  run_at: Date | string;
  expires_at: Date | string;
  last_failure_kind: string | null;
  last_error: string | null;
}

function toJob(row: JobRow): QueuedJob {
  return {
    id: row.id,
    businessId: row.business_id,
    connectionId: row.connection_id,
    kind: row.kind,
    priority: row.priority,
    serializationKey: row.serialization_key,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: toDate(row.run_at),
    expiresAt: toDate(row.expires_at),
    lastFailureKind: row.last_failure_kind,
    lastError: row.last_error,
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Whether this error is the serialization index refusing a second running job.
 *
 * Matched on the index name rather than the SQLSTATE alone, because every other
 * unique violation reachable from a claim is a bug that must not be retried
 * quietly into an infinite loop.
 */
function isSerializationKeyContest(error: unknown): boolean {
  for (let current: unknown = error; current !== undefined && current !== null;) {
    if (
      typeof current === 'object' &&
      'constraint' in current &&
      current.constraint === 'background_jobs_one_running_per_key'
    ) {
      return true;
    }

    current = typeof current === 'object' && 'cause' in current ? current.cause : null;
  }

  return false;
}
