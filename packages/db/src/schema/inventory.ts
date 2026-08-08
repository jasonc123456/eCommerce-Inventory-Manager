import { relations } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { connections } from './connections';
import { businesses, canonicalItems, locations, users } from './tenancy';

/**
 * Typed access to the inventory tables. See `schema/tenancy.ts` for why the SQL
 * migrations, not these definitions, are the source of truth.
 */

export const consumptionModes = ['reserve_until_fulfilled', 'consume_immediately'] as const;
export type ConsumptionMode = (typeof consumptionModes)[number];

/**
 * Per-business inventory operating policy (sections 8, 9, 11).
 *
 * Separate from `businesses` because these are decisions an owner revisits.
 * Changing the consumption mode requires an impact preview and either no open
 * reservations or a confirmed migration; that rule lives in the service, since
 * the database cannot see whether a person was shown a preview.
 */
export const businessInventorySettings = pgTable('business_inventory_settings', {
  businessId: uuid('business_id')
    .primaryKey()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  /** Section 8: one unit unless the owner says otherwise. */
  defaultSafetyStock: integer('default_safety_stock').notNull().default(1),
  consumptionMode: text('consumption_mode', { enum: consumptionModes })
    .notNull()
    .default('reserve_until_fulfilled'),
  /** Section 9: splitting one order across locations is opt-in. */
  splitFulfillment: boolean('split_fulfillment').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const addressPurposes = ['ship_from', 'return'] as const;
export type AddressPurpose = (typeof addressPurposes)[number];

/**
 * Where parcels leave from and where they come back to (section 9).
 *
 * Optional for inventory and required before a label can be bought from this
 * location, which is why it is a separate row rather than nullable columns on
 * `locations`: the two addresses are frequently different places.
 */
export const locationAddresses = pgTable(
  'location_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    locationId: uuid('location_id').notNull(),
    purpose: text('purpose', { enum: addressPurposes }).notNull(),
    name: text('name'),
    company: text('company'),
    line1: text('line1').notNull(),
    line2: text('line2'),
    city: text('city').notNull(),
    region: text('region'),
    postalCode: text('postal_code'),
    /** ISO 3166-1 alpha-2, upper case, enforced by a CHECK. */
    countryCode: text('country_code').notNull(),
    phone: text('phone'),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'location_addresses_location_fkey',
      columns: [table.businessId, table.locationId],
      foreignColumns: [locations.businessId, locations.id],
    }).onDelete('cascade'),
    uniqueIndex('location_addresses_unique').on(table.locationId, table.purpose),
  ],
);

/**
 * The provider's own name for an internal location (section 9).
 *
 * Explicit rather than inferred: matching on a label would put stock in the
 * wrong warehouse the first time two warehouses were named alike.
 */
export const locationChannelLinks = pgTable(
  'location_channel_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    locationId: uuid('location_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    /** An eBay merchant location key, or a store's own location identifier. */
    externalLocationId: text('external_location_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'location_channel_links_location_fkey',
      columns: [table.businessId, table.locationId],
      foreignColumns: [locations.businessId, locations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'location_channel_links_connection_fkey',
      columns: [table.businessId, table.connectionId],
      foreignColumns: [connections.businessId, connections.id],
    }).onDelete('cascade'),
    uniqueIndex('location_channel_links_external_unique').on(
      table.connectionId,
      table.externalLocationId,
    ),
    uniqueIndex('location_channel_links_location_unique').on(table.connectionId, table.locationId),
  ],
);

export const locationBalances = pgTable(
  'location_balances',
  {
    businessId: uuid('business_id').notNull(),
    canonicalItemId: uuid('canonical_item_id').notNull(),
    locationId: uuid('location_id').notNull(),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    /**
     * Withheld per location, then summed. Section 9, D-132.
     *
     * Null inherits from the item override and then the business default. A
     * stored 0 is a decision to withhold nothing here, which is a different
     * statement under a business default of one unit.
     */
    safetyStock: integer('safety_stock'),
    /** Free text. Version 1 models no warehouse hierarchy (section 9). */
    bin: text('bin'),
    note: text('note'),
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

export type BusinessInventorySettingsRow = typeof businessInventorySettings.$inferSelect;
export type NewBusinessInventorySettingsRow = typeof businessInventorySettings.$inferInsert;
export type LocationAddressRow = typeof locationAddresses.$inferSelect;
export type NewLocationAddressRow = typeof locationAddresses.$inferInsert;
export type LocationChannelLinkRow = typeof locationChannelLinks.$inferSelect;
export type NewLocationChannelLinkRow = typeof locationChannelLinks.$inferInsert;
export type LocationBalanceRow = typeof locationBalances.$inferSelect;
export type NewLocationBalanceRow = typeof locationBalances.$inferInsert;
export type LedgerEntry = typeof inventoryLedger.$inferSelect;
export type NewLedgerEntry = typeof inventoryLedger.$inferInsert;
