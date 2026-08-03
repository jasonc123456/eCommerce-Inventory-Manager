import { relations } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { canonicalItems, locations, users } from './tenancy';

/**
 * Typed access to the inventory tables. See `schema/tenancy.ts` for why the SQL
 * migrations, not these definitions, are the source of truth.
 */

export const locationBalances = pgTable(
  'location_balances',
  {
    businessId: uuid('business_id').notNull(),
    canonicalItemId: uuid('canonical_item_id').notNull(),
    locationId: uuid('location_id').notNull(),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    /** Withheld per location, then summed. Section 9, D-132. */
    safetyStock: integer('safety_stock').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'location_balances_pkey',
      columns: [table.businessId, table.canonicalItemId, table.locationId],
    }),
    // Composite foreign keys. Carrying business_id into the reference is what
    // makes a cross-business balance unrepresentable rather than merely
    // forbidden by application code (section 17).
    foreignKey({
      name: 'location_balances_item_fkey',
      columns: [table.businessId, table.canonicalItemId],
      foreignColumns: [canonicalItems.businessId, canonicalItems.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'location_balances_location_fkey',
      columns: [table.businessId, table.locationId],
      foreignColumns: [locations.businessId, locations.id],
    }).onDelete('cascade'),
  ],
);

export const ledgerKinds = [
  'receipt',
  'shipment',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'reversal',
  'reconciliation',
] as const;
export type LedgerKind = (typeof ledgerKinds)[number];

/**
 * The append-only canonical ledger.
 *
 * There is deliberately no update or delete path exposed over this table. The
 * database enforces that with a trigger, so an accidental `db.update(...)`
 * raises rather than silently rewriting history (section 17).
 */
export const inventoryLedger = pgTable(
  'inventory_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    canonicalItemId: uuid('canonical_item_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** When the physical event happened, which is not when it was recorded. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind', { enum: ledgerKinds }).notNull(),
    quantityDelta: integer('quantity_delta').notNull(),
    reversalOfId: uuid('reversal_of_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    correlationId: uuid('correlation_id'),
  },
  (table) => [
    foreignKey({
      name: 'inventory_ledger_item_fkey',
      columns: [table.businessId, table.canonicalItemId],
      foreignColumns: [canonicalItems.businessId, canonicalItems.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inventory_ledger_location_fkey',
      columns: [table.businessId, table.locationId],
      foreignColumns: [locations.businessId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inventory_ledger_reversal_of_fkey',
      columns: [table.reversalOfId],
      foreignColumns: [table.id],
    }).onDelete('restrict'),
    index('inventory_ledger_item_timeline_idx').on(
      table.businessId,
      table.canonicalItemId,
      table.occurredAt.desc(),
    ),
  ],
);

export const locationBalancesRelations = relations(locationBalances, ({ one }) => ({
  canonicalItem: one(canonicalItems, {
    fields: [locationBalances.canonicalItemId],
    references: [canonicalItems.id],
  }),
  location: one(locations, {
    fields: [locationBalances.locationId],
    references: [locations.id],
  }),
}));

export type LocationBalanceRow = typeof locationBalances.$inferSelect;
export type NewLocationBalanceRow = typeof locationBalances.$inferInsert;
export type LedgerEntry = typeof inventoryLedger.$inferSelect;
export type NewLedgerEntry = typeof inventoryLedger.$inferInsert;
