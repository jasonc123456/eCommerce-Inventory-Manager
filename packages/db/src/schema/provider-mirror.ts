import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { businesses, locations } from './tenancy';
import { importRuns, providerNames } from './connections';

/**
 * Typed access to the provider mirror (sections 6, 13, 14).
 *
 * `migrations/0006_provider_mirror.sql` is the source of truth. Everything here
 * is what a provider said; nothing here is canonical, and nothing here is
 * edited by a person.
 */

export const providerItemKinds = [
  'listing',
  'offer',
  'inventory_item',
  'product',
  'variation',
] as const;

export const managementOrigins = [
  'unknown',
  'inventory_api',
  'trading_api',
  'ambiguous',
  'woocommerce',
] as const;

export const providerItems = pgTable(
  'provider_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalId: text('external_id').notNull(),
    parentExternalId: text('parent_external_id'),
    kind: text('kind', { enum: providerItemKinds }).notNull(),
    sku: text('sku'),
    title: text('title'),
    quantity: integer('quantity'),
    backordersEnabled: boolean('backorders_enabled').notNull().default(false),
    // `numeric` in string mode: a price that has been through a float is a
    // price that may no longer be the one the provider quoted.
    priceAmount: numeric('price_amount', { precision: 18, scale: 4 }),
    priceCurrency: text('price_currency'),
    providerStatus: text('provider_status'),
    managementOrigin: text('management_origin', { enum: managementOrigins })
      .notNull()
      .default('unknown'),
    inventoryEligible: boolean('inventory_eligible').notNull().default(false),
    ineligibleReason: text('ineligible_reason'),
    raw: jsonb('raw').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    missingSince: timestamp('missing_since', { withTimezone: true }),
    lastImportRunId: uuid('last_import_run_id').references(() => importRuns.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    unique('provider_items_business_scoped').on(table.businessId, table.id),
    uniqueIndex('provider_items_external_unique').on(table.connectionId, table.externalId),
    index('provider_items_stale').on(table.connectionId, table.lastSeenAt),
  ],
);

export const providerLocations = pgTable(
  'provider_locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name'),
    merchantKey: text('merchant_key'),
    enabled: boolean('enabled').notNull().default(true),
    mappedLocationId: uuid('mapped_location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    raw: jsonb('raw').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    missingSince: timestamp('missing_since', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('provider_locations_external_unique').on(table.connectionId, table.externalId),
  ],
);

export const policyTypes = ['payment', 'return', 'fulfillment'] as const;

export const providerPolicies = pgTable(
  'provider_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalId: text('external_id').notNull(),
    policyType: text('policy_type', { enum: policyTypes }).notNull(),
    name: text('name'),
    marketplace: text('marketplace'),
    raw: jsonb('raw').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    missingSince: timestamp('missing_since', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('provider_policies_external_unique').on(
      table.connectionId,
      table.policyType,
      table.externalId,
    ),
  ],
);

export const providerOrders = pgTable(
  'provider_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalId: text('external_id').notNull(),
    externalReference: text('external_reference'),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    updatedAtProvider: timestamp('updated_at_provider', { withTimezone: true }),
    providerStatus: text('provider_status'),
    totalAmount: numeric('total_amount', { precision: 18, scale: 4 }),
    totalCurrency: text('total_currency'),
    buyerExternalId: text('buyer_external_id'),
    preActivation: boolean('pre_activation').notNull().default(false),
    raw: jsonb('raw').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastImportRunId: uuid('last_import_run_id').references(() => importRuns.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    unique('provider_orders_business_scoped').on(table.businessId, table.id),
    uniqueIndex('provider_orders_external_unique').on(table.connectionId, table.externalId),
    index('provider_orders_buyer').on(table.buyerExternalId),
  ],
);

export const providerOrderLines = pgTable(
  'provider_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    orderId: uuid('order_id').notNull(),
    externalId: text('external_id').notNull(),
    itemExternalId: text('item_external_id'),
    variationExternalId: text('variation_external_id'),
    sku: text('sku'),
    quantity: integer('quantity').notNull(),
    quantityFulfilled: integer('quantity_fulfilled').notNull().default(0),
    unitAmount: numeric('unit_amount', { precision: 18, scale: 4 }),
    currency: text('currency'),
    raw: jsonb('raw').notNull().default({}),
  },
  (table) => [
    uniqueIndex('provider_order_lines_external_unique').on(table.orderId, table.externalId),
  ],
);

export const providerRefunds = pgTable(
  'provider_refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    orderId: uuid('order_id'),
    externalId: text('external_id').notNull(),
    orderExternalId: text('order_external_id').notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }),
    currency: text('currency'),
    reason: text('reason'),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    raw: jsonb('raw').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('provider_refunds_external_unique').on(table.connectionId, table.externalId),
  ],
);

export const notificationTopicStatuses = [
  'discovered',
  'subscribed',
  'unavailable',
  'failed',
  'unsubscribed',
] as const;

export const providerNotificationTopics = pgTable(
  'provider_notification_topics',
  {
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    topic: text('topic').notNull(),
    status: text('status', { enum: notificationTopicStatuses }).notNull().default('discovered'),
    subscriptionId: text('subscription_id'),
    summary: text('summary'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
    subscribedAt: timestamp('subscribed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.topic] })],
);

export const deletionRequestStatuses = [
  'received',
  'processing',
  'completed',
  'partially_failed',
  'rejected',
] as const;

export const marketplaceDeletionRequests = pgTable(
  'marketplace_deletion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider', { enum: providerNames }).notNull().default('ebay'),
    buyerExternalId: text('buyer_external_id').notNull(),
    notificationId: text('notification_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    verified: boolean('verified').notNull().default(false),
    status: text('status', { enum: deletionRequestStatuses }).notNull().default('received'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('marketplace_deletion_requests_notification_unique').on(
      table.provider,
      table.notificationId,
    ),
    index('marketplace_deletion_requests_buyer').on(table.buyerExternalId),
  ],
);

export const deletionOutcomeStatuses = [
  'pending',
  'completed',
  'failed',
  'nothing_to_erase',
] as const;

export const marketplaceDeletionOutcomes = pgTable(
  'marketplace_deletion_outcomes',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => marketplaceDeletionRequests.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    status: text('status', { enum: deletionOutcomeStatuses }).notNull().default('pending'),
    summary: text('summary'),
    recordsAffected: integer('records_affected').notNull().default(0),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.businessId] })],
);
