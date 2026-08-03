import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Typed access to the leader-election and liveness tables. */

export const backgroundRoles = ['worker', 'scheduler'] as const;
export type BackgroundRole = (typeof backgroundRoles)[number];

export const schedulerLeases = pgTable('scheduler_leases', {
  role: text('role', { enum: ['scheduler'] }).primaryKey(),
  holderId: uuid('holder_id').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastHeartbeat: timestamp('last_heartbeat', { withTimezone: true }).notNull().defaultNow(),
  appVersion: text('app_version'),
});

export const workerHeartbeats = pgTable(
  'worker_heartbeats',
  {
    workerId: uuid('worker_id').primaryKey(),
    role: text('role', { enum: backgroundRoles }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    appVersion: text('app_version'),
    activeJobs: integer('active_jobs').notNull().default(0),
  },
  (table) => [index('worker_heartbeats_last_seen_idx').on(table.lastSeenAt)],
);

export type SchedulerLease = typeof schedulerLeases.$inferSelect;
export type WorkerHeartbeat = typeof workerHeartbeats.$inferSelect;
