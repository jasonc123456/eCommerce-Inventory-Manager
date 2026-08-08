import {
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { connections } from './connections';
import { providerItems } from './provider-mirror';
import { canonicalItems, locations, users } from './tenancy';

/**
 * Typed access to the mapping tables (sections 6, 7, 9).
 *
 * See `schema/tenancy.ts` for why the SQL migrations, not these definitions, are
 * the source of truth.
 */

/** A PostgreSQL uuid array, typed as `string[]`. */
const uuidArray = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => 'uuid[]',
});

export const mappingStatuses = ['draft', 'approved', 'active', 'paused', 'archived'] as const;
export type MappingStatus = (typeof mappingStatuses)[number];

/** Statuses in which a mapping still owns its channel entity (section 7). */
export const LIVE_MAPPING_STATUSES = ['draft', 'approved', 'active', 'paused'] as const;

export const channelMappings = pgTable(
  'channel_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    /** The imported channel entity this mapping sells the item as. */
    providerItemId: uuid('provider_item_id').notNull(),
    canonicalItemId: uuid('canonical_item_id').notNull(),
    status: text('status', { enum: mappingStatuses }).notNull().default('draft'),
    /** Required whenever the status is paused; the database insists. */
    pauseReason: text('pause_reason'),
    /** Section 8: withheld from this channel only, never from the pool. */
    channelBuffer: integer('channel_buffer').notNull().default(0),
    channelCap: integer('channel_cap'),
    version: integer('version').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('channel_mappings_business_scoped').on(table.businessId, table.id),
    foreignKey({
      name: 'channel_mappings_item_fkey',
      columns: [table.businessId, table.canonicalItemId],
      foreignColumns: [canonicalItems.businessId, canonicalItems.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'channel_mappings_connection_fkey',
      columns: [table.businessId, table.connectionId],
      foreignColumns: [connections.businessId, connections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'channel_mappings_provider_item_fkey',
      columns: [table.businessId, table.providerItemId],
      foreignColumns: [providerItems.businessId, providerItems.id],
    }).onDelete('restrict'),
    index('channel_mappings_by_connection').on(table.connectionId, table.status),
  ],
);

export const channelMappingLocations = pgTable(
  'channel_mapping_locations',
  {
    businessId: uuid('business_id').notNull(),
    mappingId: uuid('mapping_id').notNull(),
    locationId: uuid('location_id').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'channel_mapping_locations_pkey',
      columns: [table.mappingId, table.locationId],
    }),
    foreignKey({
      name: 'channel_mapping_locations_mapping_fkey',
      columns: [table.businessId, table.mappingId],
      foreignColumns: [channelMappings.businessId, channelMappings.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'channel_mapping_locations_location_fkey',
      columns: [table.businessId, table.locationId],
      foreignColumns: [locations.businessId, locations.id],
    }).onDelete('restrict'),
  ],
);

/**
 * What a mapping used to be (section 7).
 *
 * Append-only, enforced by a trigger, for the same reason the ledger is: an
 * order from March is explained by the version that was live in March.
 */
export const channelMappingVersions = pgTable(
  'channel_mapping_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    mappingId: uuid('mapping_id').notNull(),
    version: integer('version').notNull(),
    canonicalItemId: uuid('canonical_item_id').notNull(),
    channelBuffer: integer('channel_buffer').notNull(),
    channelCap: integer('channel_cap'),
    locationIds: uuidArray('location_ids').notNull().default([]),
    status: text('status', { enum: mappingStatuses }).notNull(),
    changeReason: text('change_reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('channel_mapping_versions_unique').on(table.mappingId, table.version),
    foreignKey({
      name: 'channel_mapping_versions_mapping_fkey',
      columns: [table.businessId, table.mappingId],
      foreignColumns: [channelMappings.businessId, channelMappings.id],
    }).onDelete('cascade'),
  ],
);

export type ChannelMapping = typeof channelMappings.$inferSelect;
export type NewChannelMapping = typeof channelMappings.$inferInsert;
export type ChannelMappingLocation = typeof channelMappingLocations.$inferSelect;
export type ChannelMappingVersion = typeof channelMappingVersions.$inferSelect;
export type NewChannelMappingVersion = typeof channelMappingVersions.$inferInsert;
