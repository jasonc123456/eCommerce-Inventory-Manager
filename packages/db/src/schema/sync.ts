import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { backgroundJobs } from './jobs';

/**
 * Typed access to the desired-target tables (sections 8, 12, 15).
 *
 * `migrations/0015_channel_targets.sql` is the source of truth. The check that
 * carries the real guarantee — a written version can never run ahead of the
 * desired version — lives only in the SQL.
 */

export const channelTargetStates = ['pending', 'converged', 'degraded', 'blocked'] as const;
export type ChannelTargetState = (typeof channelTargetStates)[number];

export const channelTargets = pgTable(
  'channel_targets',
  {
    businessId: uuid('business_id').notNull(),
    mappingId: uuid('mapping_id').primaryKey(),
    targetVersion: bigint('target_version', { mode: 'number' }).notNull().default(1),
    desiredQuantity: integer('desired_quantity').notNull(),
    reason: text('reason'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    writtenVersion: bigint('written_version', { mode: 'number' }),
    writtenQuantity: integer('written_quantity'),
    writtenAt: timestamp('written_at', { withTimezone: true }),
    observedQuantity: integer('observed_quantity'),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    observedVersion: text('observed_version'),
    observedBackorders: boolean('observed_backorders'),
    state: text('state', { enum: channelTargetStates }).notNull().default('pending'),
    stateReason: text('state_reason'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('channel_targets_unconverged').on(table.businessId, table.state, table.updatedAt),
  ],
);

export const channelWriteOutcomes = [
  'sent',
  'acknowledged',
  'unchanged',
  'failed',
  'superseded',
] as const;
export type ChannelWriteOutcome = (typeof channelWriteOutcomes)[number];

export const channelWriteAttempts = pgTable(
  'channel_write_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    mappingId: uuid('mapping_id').notNull(),
    jobId: uuid('job_id').references(() => backgroundJobs.id, { onDelete: 'set null' }),
    targetVersion: bigint('target_version', { mode: 'number' }).notNull(),
    quantity: integer('quantity').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    outcome: text('outcome', { enum: channelWriteOutcomes }),
    failureKind: text('failure_kind'),
    detail: text('detail'),
    verifiedQuantity: integer('verified_quantity'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('channel_write_attempts_recent').on(table.mappingId, table.startedAt)],
);

export type ChannelTarget = typeof channelTargets.$inferSelect;
export type ChannelWriteAttempt = typeof channelWriteAttempts.$inferSelect;
