import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { businesses } from './tenancy';

/**
 * Typed access to the durable job queue (sections 12, 15).
 *
 * `migrations/0014_jobs.sql` is the source of truth. The two partial unique
 * indexes that carry the real guarantees — one running job per serialization
 * key, one pending job per dedupe key — are not expressible here and live only
 * in the SQL; `queue.integration.test.ts` is what proves they are still there.
 */

export const jobStatuses = ['ready', 'running', 'succeeded', 'dead', 'cancelled'] as const;
export type JobStatus = (typeof jobStatuses)[number];

export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id'),
    kind: text('kind').notNull(),
    priority: integer('priority').notNull().default(50),
    serializationKey: text('serialization_key'),
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').notNull().default({}),
    status: text('status', { enum: jobStatuses }).notNull().default('ready'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedBy: uuid('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimLeaseExpiresAt: timestamp('claim_lease_expires_at', { withTimezone: true }),
    lastFailureKind: text('last_failure_kind'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('background_jobs_by_business').on(
      table.businessId,
      table.kind,
      table.status,
      table.createdAt,
    ),
  ],
);

export const jobAttemptOutcomes = ['succeeded', 'failed', 'superseded', 'reclaimed'] as const;
export type JobAttemptOutcome = (typeof jobAttemptOutcomes)[number];

export const backgroundJobAttempts = pgTable(
  'background_job_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => backgroundJobs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    workerId: uuid('worker_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outcome: text('outcome', { enum: jobAttemptOutcomes }),
    failureKind: text('failure_kind'),
    detail: text('detail'),
    retryAfterMs: integer('retry_after_ms'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  },
  (table) => [index('background_job_attempts_by_job').on(table.jobId, table.attempt)],
);

export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type BackgroundJobAttempt = typeof backgroundJobAttempts.$inferSelect;
