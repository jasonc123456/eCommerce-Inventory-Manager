import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { inventoryLedger } from './inventory';
import { users } from './tenancy';

/**
 * Typed access to restock candidates (section 11).
 *
 * `migrations/0017_restock_candidates.sql` is the source of truth. The check
 * that makes "confirmed" mean one thing — a confirmed candidate has both a
 * quantity and a location — lives only in the SQL.
 */

export const restockOrigins = [
  'refund',
  'return',
  'dispute',
  'cancellation_after_shipment',
] as const;
export type RestockOrigin = (typeof restockOrigins)[number];

export const restockStatuses = ['pending', 'confirmed', 'declined', 'superseded'] as const;
export type RestockStatus = (typeof restockStatuses)[number];

export const restockCandidates = pgTable(
  'restock_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    orderId: uuid('order_id'),
    orderLineId: uuid('order_line_id'),
    externalOrderId: text('external_order_id').notNull(),
    externalLineId: text('external_line_id'),
    canonicalItemId: uuid('canonical_item_id'),
    origin: text('origin', { enum: restockOrigins }).notNull(),
    claimedQuantity: integer('claimed_quantity').notNull(),
    status: text('status', { enum: restockStatuses }).notNull().default('pending'),
    confirmedQuantity: integer('confirmed_quantity'),
    confirmedLocationId: uuid('confirmed_location_id'),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    ledgerEntryId: uuid('ledger_entry_id').references(() => inventoryLedger.id, {
      onDelete: 'restrict',
    }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('restock_candidates_unique').on(
      table.connectionId,
      table.externalOrderId,
      table.externalLineId,
      table.origin,
    ),
    index('restock_candidates_pending').on(table.businessId, table.createdAt),
  ],
);

export type RestockCandidate = typeof restockCandidates.$inferSelect;
