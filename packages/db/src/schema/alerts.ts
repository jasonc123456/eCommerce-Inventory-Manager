import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { backgroundJobs } from './jobs';
import { inventoryConflicts } from './reconciliation';
import { businesses, users } from './tenancy';

/**
 * Typed access to operator alerts (sections 11, 12, 22).
 *
 * `migrations/0020_alerts.sql` is the source of truth. The partial unique index
 * that keeps one open alert per subject is not expressible here, and it is the
 * part that matters: without it a mapping blocked for six hours becomes seven
 * hundred things to read rather than one thing to fix.
 */

export const alertKinds = [
  'oversold',
  'mapping_blocked',
  'job_dead_lettered',
  'connection_unhealthy',
  'restock_pending',
  'reconciliation_conflict',
] as const;
export type AlertKind = (typeof alertKinds)[number];

export const alertSeverities = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof alertSeverities)[number];

export const operatorAlerts = pgTable(
  'operator_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: alertKinds }).notNull(),
    severity: text('severity', { enum: alertSeverities }).notNull().default('warning'),
    subjectKey: text('subject_key').notNull(),
    summary: text('summary').notNull(),
    detail: jsonb('detail').notNull().default({}),
    mappingId: uuid('mapping_id'),
    canonicalItemId: uuid('canonical_item_id'),
    connectionId: uuid('connection_id'),
    conflictId: uuid('conflict_id').references(() => inventoryConflicts.id, {
      onDelete: 'set null',
    }),
    jobId: uuid('job_id').references(() => backgroundJobs.id, { onDelete: 'set null' }),
    occurrences: integer('occurrences').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedByUserId: uuid('acknowledged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acknowledgementNote: text('acknowledgement_note'),
  },
  (table) => [
    index('operator_alerts_unacknowledged').on(table.businessId, table.severity, table.lastSeenAt),
  ],
);

export type OperatorAlert = typeof operatorAlerts.$inferSelect;
