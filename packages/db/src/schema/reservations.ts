import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { connections } from './connections';
import { consumptionModes } from './inventory';
import { kitRecipes } from './kits';
import { canonicalItems, locations } from './tenancy';

/**
 * Typed access to reservations and allocations (sections 9, 11, 12).
 *
 * See `schema/tenancy.ts` for why the SQL migrations, not these definitions, are
 * the source of truth.
 */

export const reservationStatuses = ['open', 'consumed', 'released'] as const;
export type ReservationStatus = (typeof reservationStatuses)[number];

export const stockReservations = pgTable(
  'stock_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    /** What was ordered. A kit's allocations name its components instead. */
    canonicalItemId: uuid('canonical_item_id').notNull(),
    quantity: integer('quantity').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    externalLineId: text('external_line_id').notNull(),
    /** The mode in force when the order was taken, not when it is cancelled. */
    consumptionMode: text('consumption_mode', { enum: consumptionModes }).notNull(),
    /** Section 10: a kit sale is reversed with the recipe active at purchase. */
    kitRecipeId: uuid('kit_recipe_id').references(() => kitRecipes.id, { onDelete: 'restrict' }),
    status: text('status', { enum: reservationStatuses }).notNull().default('open'),
    /** Section 11: recorded explicitly, never as a negative balance. */
    shortage: integer('shortage').notNull().default(0),
    /** Section 9: no single location could fulfil and splitting is disabled. */
    splitBlocked: boolean('split_blocked').notNull().default(false),
    releasedReason: text('released_reason'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('stock_reservations_business_scoped').on(table.businessId, table.id),
    uniqueIndex('stock_reservations_line_unique').on(
      table.connectionId,
      table.externalOrderId,
      table.externalLineId,
    ),
    foreignKey({
      name: 'stock_reservations_item_fkey',
      columns: [table.businessId, table.canonicalItemId],
      foreignColumns: [canonicalItems.businessId, canonicalItems.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'stock_reservations_connection_fkey',
      columns: [table.businessId, table.connectionId],
      foreignColumns: [connections.businessId, connections.id],
    }).onDelete('cascade'),
  ],
);

export const reservationAllocations = pgTable(
  'reservation_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    reservationId: uuid('reservation_id').notNull(),
    /** The stocked item taken: the ordered item, or a kit component. */
    canonicalItemId: uuid('canonical_item_id').notNull(),
    locationId: uuid('location_id').notNull(),
    quantity: integer('quantity').notNull(),
    /** Set when the units were consumed immediately; a cancellation reverses it. */
    ledgerEntryId: uuid('ledger_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('reservation_allocations_unique').on(
      table.reservationId,
      table.canonicalItemId,
      table.locationId,
    ),
    foreignKey({
      name: 'reservation_allocations_reservation_fkey',
      columns: [table.businessId, table.reservationId],
      foreignColumns: [stockReservations.businessId, stockReservations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'reservation_allocations_item_fkey',
      columns: [table.businessId, table.canonicalItemId],
      foreignColumns: [canonicalItems.businessId, canonicalItems.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reservation_allocations_location_fkey',
      columns: [table.businessId, table.locationId],
      foreignColumns: [locations.businessId, locations.id],
    }).onDelete('restrict'),
    index('reservation_allocations_by_item').on(
      table.businessId,
      table.canonicalItemId,
      table.locationId,
    ),
  ],
);

export type StockReservation = typeof stockReservations.$inferSelect;
export type NewStockReservation = typeof stockReservations.$inferInsert;
export type ReservationAllocation = typeof reservationAllocations.$inferSelect;
export type NewReservationAllocation = typeof reservationAllocations.$inferInsert;
