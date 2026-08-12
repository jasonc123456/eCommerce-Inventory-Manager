import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { businesses } from './tenancy';

/**
 * Typed access to retention (sections 13, 22, 37).
 *
 * `migrations/0029_retention.sql` is the source of truth, and the part not
 * expressible here is the one that matters: raw event bodies have a ceiling as
 * well as a default, because they hold buyer data section 13 obliges this
 * application to be able to erase.
 */

/**
 * The classes a sweep deletes, and the two policies they fall under.
 *
 * Split by risk rather than by table, following section 37: what this
 * application wrote about itself is history, and what arrived from somewhere
 * else and has not been normalized is a raw body somebody may have a right to
 * have removed.
 */
export const historyDataClasses = [
  'notification_deliveries',
  'resolved_alerts',
  'ai_suggestions',
] as const;

export const rawDataClasses = ['webhook_deliveries', 'processed_events'] as const;

export const retentionDataClasses = [...historyDataClasses, ...rawDataClasses] as const;
export type RetentionDataClass = (typeof retentionDataClasses)[number];

export function isRawDataClass(dataClass: RetentionDataClass): boolean {
  return (rawDataClasses as readonly string[]).includes(dataClass);
}

export const businessRetentionSettings = pgTable('business_retention_settings', {
  businessId: uuid('business_id')
    .primaryKey()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  /** Section 22's 180-day default. Zero means keep. */
  historyDays: integer('history_days').notNull().default(180),
  /** Section 37's 30-day default. Never zero, and capped by the schema. */
  rawEventDays: integer('raw_event_days').notNull().default(30),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BusinessRetentionSettings = typeof businessRetentionSettings.$inferSelect;

export const retentionRuns = pgTable(
  'retention_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    dataClass: text('data_class', { enum: retentionDataClasses }).notNull(),
    /** A count, never a list. A list would be a copy of what was deleted. */
    rowsDeleted: integer('rows_deleted').notNull(),
    olderThan: timestamp('older_than', { withTimezone: true }).notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('retention_runs_recent').on(table.ranAt)],
);

export type RetentionRun = typeof retentionRuns.$inferSelect;
