import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Typed access to per-connection sync cadence (section 15).
 *
 * `migrations/0018_sync_cadence.sql` is the source of truth. The check that
 * makes adaptive throttling one-way — the effective interval may exceed the
 * target but never undercut it — lives only in the SQL.
 */

export const connectionSyncSettings = pgTable(
  'connection_sync_settings',
  {
    connectionId: uuid('connection_id').primaryKey(),
    businessId: uuid('business_id').notNull(),
    targetIntervalSeconds: integer('target_interval_seconds').notNull().default(30),
    effectiveIntervalSeconds: integer('effective_interval_seconds').notNull().default(30),
    effectiveReason: text('effective_reason'),
    lastOrderPollAt: timestamp('last_order_poll_at', { withTimezone: true }),
    lastDirtySweepAt: timestamp('last_dirty_sweep_at', { withTimezone: true }),
    lastFullSweepAt: timestamp('last_full_sweep_at', { withTimezone: true }),
    lastOrderRescanAt: timestamp('last_order_rescan_at', { withTimezone: true }),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    lastCatalogSweepAt: timestamp('last_catalog_sweep_at', { withTimezone: true }),
    paused: boolean('paused').notNull().default(false),
    pausedReason: text('paused_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('connection_sync_settings_by_business').on(table.businessId)],
);

export type ConnectionSyncSettings = typeof connectionSyncSettings.$inferSelect;
