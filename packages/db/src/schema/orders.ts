import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { stockReservations } from './reservations';

/**
 * Typed access to the order and event tables (sections 11, 12, 15).
 *
 * `migrations/0016_orders.sql` is the source of truth. The two partial unique
 * indexes on `processed_events` — provider event id where there is one, payload
 * fingerprint where there is not — are the deduplication boundary for the whole
 * pipeline and are not expressible here.
 */

export const demandStates = [
  'awaiting',
  'committed',
  'fulfilled',
  'cancelled',
  'refunded',
] as const;
export type DemandState = (typeof demandStates)[number];

export const channelOrders = pgTable(
  'channel_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    externalOrderId: text('external_order_id').notNull(),
    providerStatus: text('provider_status'),
    demandState: text('demand_state', { enum: demandStates }).notNull().default('awaiting'),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    firstCommittedAt: timestamp('first_committed_at', { withTimezone: true }),
    providerRevision: text('provider_revision'),
    providerSequence: bigint('provider_sequence', { mode: 'number' }),
    currency: text('currency'),
    totalAmount: numeric('total_amount', { precision: 18, scale: 4 }),
    buyerReference: text('buyer_reference'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('channel_orders_unique').on(table.connectionId, table.externalOrderId),
    index('channel_orders_by_state').on(table.businessId, table.demandState, table.updatedAt),
  ],
);

export const lineTreatments = [
  'untreated',
  'reserved',
  'consumed',
  'unmapped',
  'ineligible',
  'released',
] as const;
export type LineTreatment = (typeof lineTreatments)[number];

export const channelOrderLines = pgTable(
  'channel_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    orderId: uuid('order_id').notNull(),
    externalLineId: text('external_line_id').notNull(),
    externalItemId: text('external_item_id'),
    variationId: text('variation_id'),
    sku: text('sku'),
    title: text('title'),
    quantity: integer('quantity').notNull(),
    cancelledQuantity: integer('cancelled_quantity').notNull().default(0),
    shippedQuantity: integer('shipped_quantity').notNull().default(0),
    refundedQuantity: integer('refunded_quantity').notNull().default(0),
    treatment: text('treatment', { enum: lineTreatments }).notNull().default('untreated'),
    treatmentReason: text('treatment_reason'),
    mappingId: uuid('mapping_id'),
    canonicalItemId: uuid('canonical_item_id'),
    reservationId: uuid('reservation_id').references(() => stockReservations.id, {
      onDelete: 'set null',
    }),
    shortage: integer('shortage').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('channel_order_lines_unique').on(table.orderId, table.externalLineId),
    index('channel_order_lines_by_order').on(table.orderId),
  ],
);

export const eventSources = [
  'webhook',
  'poll',
  'verification',
  'manual',
  'reconciliation',
] as const;
export type EventSource = (typeof eventSources)[number];

export const processedEvents = pgTable(
  'processed_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id'),
    connectionId: uuid('connection_id').notNull(),
    provider: text('provider').notNull(),
    source: text('source', { enum: eventSources }).notNull(),
    eventType: text('event_type').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    externalEventId: text('external_event_id'),
    revision: text('revision'),
    payloadFingerprint: text('payload_fingerprint'),
    outcome: jsonb('outcome').notNull().default({}),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('processed_events_retention').on(table.processedAt)],
);

export type ChannelOrder = typeof channelOrders.$inferSelect;
export type ChannelOrderLine = typeof channelOrderLines.$inferSelect;
export type ProcessedEvent = typeof processedEvents.$inferSelect;
