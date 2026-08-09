import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { businesses, users } from './tenancy';

/**
 * Typed access to the shipping tables (sections 2, 9, 13, 14, 21, 34).
 *
 * As everywhere else in this package, `migrations/0023_shipping.sql` is the
 * source of truth and this is the query surface over it. Three things that
 * matter most live only in the SQL: the partial unique index that permits one
 * live label per package, the not-null reference from a label to the reviewed
 * operation that authorized it, and the composite foreign keys that make a
 * cross-business package unstorable.
 */

export const shippingProviders = ['easypost', 'easyship'] as const;
export type ShippingProvider = (typeof shippingProviders)[number];

export const shippingAccountStatuses = ['pending', 'active', 'paused', 'disconnected'] as const;
export type ShippingAccountStatus = (typeof shippingAccountStatuses)[number];

export const shippingAccounts = pgTable(
  'shipping_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: shippingProviders }).notNull(),
    environment: text('environment', { enum: ['sandbox', 'production'] }).notNull(),
    displayName: text('display_name').notNull(),
    status: text('status', { enum: shippingAccountStatuses }).notNull().default('pending'),
    /** What the provider says it will do. Recorded, never assumed. */
    capabilities: jsonb('capabilities').notNull().default({}),
    accountLabel: text('account_label'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastFailureSummary: text('last_failure_summary'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('shipping_accounts_one_per_provider').on(
      table.businessId,
      table.provider,
      table.environment,
    ),
    unique('shipping_accounts_business_scoped').on(table.businessId, table.id),
    index('shipping_accounts_by_business').on(table.businessId, table.status),
  ],
);

export const shippingSecretTypes = ['easypost_api_key', 'easyship_api_key'] as const;
export type ShippingSecretType = (typeof shippingSecretTypes)[number];

export const shippingAccountSecrets = pgTable(
  'shipping_account_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    accountId: uuid('account_id').notNull(),
    secretType: text('secret_type', { enum: shippingSecretTypes }).notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [index('shipping_account_secrets_key_version').on(table.keyVersion)],
);

export const shipmentPackageStatuses = ['draft', 'labelled', 'shipped', 'cancelled'] as const;
export type ShipmentPackageStatus = (typeof shipmentPackageStatuses)[number];

export const shipmentPackages = pgTable(
  'shipment_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    locationId: uuid('location_id').notNull(),
    status: text('status', { enum: shipmentPackageStatuses }).notNull().default('draft'),
    weightGrams: integer('weight_grams').notNull(),
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    declaredValueAmount: numeric('declared_value_amount', { precision: 18, scale: 4 }),
    declaredValueCurrency: text('declared_value_currency'),
    reference: text('reference'),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    shippedByUserId: uuid('shipped_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (table) => [
    unique('shipment_packages_business_scoped').on(table.businessId, table.id),
    index('shipment_packages_by_order').on(table.businessId, table.orderId, table.createdAt),
  ],
);

export const shipmentPackageLines = pgTable(
  'shipment_package_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    packageId: uuid('package_id').notNull(),
    orderLineId: uuid('order_line_id').notNull(),
    quantity: integer('quantity').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('shipment_package_lines_unique').on(table.packageId, table.orderLineId),
    index('shipment_package_lines_by_order_line').on(table.businessId, table.orderLineId),
  ],
);

export const shipmentRateQuotes = pgTable(
  'shipment_rate_quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    packageId: uuid('package_id').notNull(),
    accountId: uuid('account_id').notNull(),
    providerShipmentId: text('provider_shipment_id').notNull(),
    /** Every rate offered, exactly as quoted. Shown; never recomputed. */
    rates: jsonb('rates').notNull(),
    quotedAt: timestamp('quoted_at', { withTimezone: true }).notNull(),
    /** The provider's own deadline, where it publishes one. */
    providerExpiresAt: timestamp('provider_expires_at', { withTimezone: true }),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('shipment_rate_quotes_business_scoped').on(table.businessId, table.id),
    index('shipment_rate_quotes_recent').on(table.businessId, table.packageId, table.quotedAt),
  ],
);

export const shipmentLabelStates = [
  'purchased',
  'void_requested',
  'voided',
  'void_refused',
] as const;
export type ShipmentLabelState = (typeof shipmentLabelStates)[number];

/** States in which a package still has a usable label and cannot buy another. */
export const LIVE_LABEL_STATES: readonly ShipmentLabelState[] = ['purchased', 'void_requested'];

export const shipmentLabels = pgTable(
  'shipment_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    packageId: uuid('package_id').notNull(),
    accountId: uuid('account_id').notNull(),
    quoteId: uuid('quote_id').notNull(),
    /**
     * The confirmation that bought this. Not null in the migration, which is
     * what makes a label nobody authorized impossible to store rather than
     * merely unlikely.
     */
    operationId: uuid('operation_id').notNull(),
    providerLabelId: text('provider_label_id').notNull(),
    providerShipmentId: text('provider_shipment_id').notNull(),
    rateId: text('rate_id').notNull(),
    carrier: text('carrier').notNull(),
    service: text('service').notNull(),
    trackingNumber: text('tracking_number').notNull(),
    amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
    currency: text('currency').notNull(),
    purchasedAt: timestamp('purchased_at', { withTimezone: true }).notNull(),
    state: text('state', { enum: shipmentLabelStates }).notNull().default('purchased'),
    refundAmount: numeric('refund_amount', { precision: 18, scale: 4 }),
    refundCurrency: text('refund_currency'),
    voidRequestedAt: timestamp('void_requested_at', { withTimezone: true }),
    voidRequestedByUserId: uuid('void_requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidDetail: text('void_detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('shipment_labels_business_scoped').on(table.businessId, table.id),
    // The real index is partial — one live label per package, so a voided one
    // frees the package for a replacement. Declared here for the shape it
    // enforces; the migration is what enforces it.
    uniqueIndex('shipment_labels_one_live_per_package').on(table.businessId, table.packageId),
    uniqueIndex('shipment_labels_provider_unique').on(table.accountId, table.providerLabelId),
    index('shipment_labels_by_tracking').on(table.businessId, table.trackingNumber),
  ],
);

export const trackingStatuses = [
  'pre_transit',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'available_for_pickup',
  'return_to_sender',
  'failure',
  'unknown',
] as const;
export type ShipmentTrackingStatus = (typeof trackingStatuses)[number];

export const shipmentTrackingEvents = pgTable(
  'shipment_tracking_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    labelId: uuid('label_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    status: text('status', { enum: trackingStatuses }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    description: text('description'),
    location: text('location'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('shipment_tracking_events_unique').on(table.labelId, table.providerEventId),
    index('shipment_tracking_events_recent').on(table.businessId, table.labelId, table.occurredAt),
  ],
);

export const channelPushKinds = [
  'ebay_fulfillment',
  'woocommerce_order_note',
  'woocommerce_status',
] as const;
export type ChannelPushKind = (typeof channelPushKinds)[number];

export const channelPushStates = ['pending', 'succeeded', 'failed', 'unsupported'] as const;
export type ChannelPushState = (typeof channelPushStates)[number];

export const shipmentChannelPushes = pgTable(
  'shipment_channel_pushes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    packageId: uuid('package_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    kind: text('kind', { enum: channelPushKinds }).notNull(),
    state: text('state', { enum: channelPushStates }).notNull().default('pending'),
    externalReference: text('external_reference'),
    idempotencyKey: text('idempotency_key').notNull(),
    attempts: integer('attempts').notNull().default(0),
    failureSummary: text('failure_summary'),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('shipment_channel_pushes_idempotent').on(table.businessId, table.idempotencyKey),
    index('shipment_channel_pushes_by_package').on(
      table.businessId,
      table.packageId,
      table.createdAt,
    ),
  ],
);

export type ShippingAccount = typeof shippingAccounts.$inferSelect;
export type ShippingAccountSecret = typeof shippingAccountSecrets.$inferSelect;
export type ShipmentPackage = typeof shipmentPackages.$inferSelect;
export type ShipmentPackageLine = typeof shipmentPackageLines.$inferSelect;
export type ShipmentRateQuote = typeof shipmentRateQuotes.$inferSelect;
export type ShipmentLabel = typeof shipmentLabels.$inferSelect;
export type ShipmentTrackingEvent = typeof shipmentTrackingEvents.$inferSelect;
export type ShipmentChannelPush = typeof shipmentChannelPushes.$inferSelect;
