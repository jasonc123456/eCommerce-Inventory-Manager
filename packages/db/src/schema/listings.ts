import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { businesses, users } from './tenancy';

/**
 * Typed access to reviewed listing operations (sections 11, 13, 14, 30).
 *
 * `migrations/0021_reviewed_operations.sql` is the source of truth, and here
 * more than usual: the two things this table exists to guarantee are a partial
 * unique index and a trigger, and neither is expressible in Drizzle. One live
 * operation per subject stops a person assembling a recurring price change by
 * clicking four times; the settled-stays-settled trigger stops one confirmation
 * producing a second effect. Reading only this file would suggest an ordinary
 * status column that anything could move in any direction.
 */

export const reviewedOperationKinds = [
  'draft_create',
  'draft_publish',
  'price_copy',
  'restock_to_live',
  'order_copy',
] as const;
export type ReviewedOperationKind = (typeof reviewedOperationKinds)[number];

export const reviewedOperationStates = [
  'proposed',
  'confirmed',
  'executing',
  'executed',
  'failed',
  'expired',
  'cancelled',
] as const;
export type ReviewedOperationState = (typeof reviewedOperationStates)[number];

/** States from which nothing further happens. The trigger enforces this. */
export const SETTLED_OPERATION_STATES = ['executed', 'failed', 'expired', 'cancelled'] as const;

export const reviewedOperationRefusalReasons = [
  'already_decided',
  'expired',
  'stale_preview',
  'stale_source',
  'not_permitted',
  'recent_authentication_required',
] as const;
export type ReviewedOperationRefusalReason = (typeof reviewedOperationRefusalReasons)[number];

export const reviewedOperations = pgTable(
  'reviewed_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: reviewedOperationKinds }).notNull(),
    state: text('state', { enum: reviewedOperationStates }).notNull().default('proposed'),
    subjectKey: text('subject_key').notNull(),
    requiredPermission: text('required_permission').notNull(),
    requiresRecentAuthentication: boolean('requires_recent_authentication').notNull().default(true),
    preview: jsonb('preview').notNull(),
    previewFingerprint: text('preview_fingerprint').notNull(),
    sourceObservedAt: timestamp('source_observed_at', { withTimezone: true }).notNull(),
    sourceMaxAgeMs: bigint('source_max_age_ms', { mode: 'number' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    mappingId: uuid('mapping_id'),
    canonicalItemId: uuid('canonical_item_id'),
    sourceConnectionId: uuid('source_connection_id'),
    destinationConnectionId: uuid('destination_connection_id'),
    externalReference: text('external_reference'),
    parentOperationId: uuid('parent_operation_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    proposedByUserId: uuid('proposed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    outcome: jsonb('outcome'),
    failureSummary: text('failure_summary'),
  },
  (table) => [
    index('reviewed_operations_recent').on(table.businessId, table.proposedAt),
    index('reviewed_operations_by_parent').on(table.parentOperationId),
  ],
);

export const reviewedOperationRefusals = pgTable(
  'reviewed_operation_refusals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationId: uuid('operation_id')
      .notNull()
      .references(() => reviewedOperations.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').notNull(),
    reason: text('reason', { enum: reviewedOperationRefusalReasons }).notNull(),
    attemptedByUserId: uuid('attempted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    detail: text('detail'),
    refusedAt: timestamp('refused_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('reviewed_operation_refusals_by_operation').on(table.operationId)],
);

export type ReviewedOperation = typeof reviewedOperations.$inferSelect;
export type ReviewedOperationRefusal = typeof reviewedOperationRefusals.$inferSelect;
