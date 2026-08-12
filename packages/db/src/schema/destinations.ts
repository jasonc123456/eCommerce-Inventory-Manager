import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { alertSeverities } from './alerts';
import { businesses } from './tenancy';

/**
 * Typed access to outbound alert destinations (sections 19, 22).
 *
 * `migrations/0028_alert_destinations.sql` is the source of truth. Two things
 * it enforces are not expressible here and both are load-bearing: a destination
 * cannot be enabled until it has answered, and a delivery is addressed either
 * to a person or to a destination and never to both.
 *
 * The endpoint URL is deliberately not a column. A Slack incoming-webhook URL
 * is a bearer credential, so it lives encrypted in `alertDestinationSecrets`
 * under the same custody as every other business secret; what is here is the
 * host, which is what a screen needs to say where something goes.
 */

export const alertDestinationKinds = ['slack', 'discord', 'webhook'] as const;
export type AlertDestinationKind = (typeof alertDestinationKinds)[number];

// Named for the alert side because `provider-mirror.ts` already has a
// `destinationStatuses` for eBay's own notification destinations, and the two
// mean different things: that one is what eBay says about a registration, this
// is whether our own send worked.
export const alertDestinationStatuses = ['unchecked', 'ready', 'failing'] as const;
export type AlertDestinationStatus = (typeof alertDestinationStatuses)[number];

export const alertDestinationSecretTypes = ['endpoint_url', 'signing_key'] as const;
export type AlertDestinationSecretType = (typeof alertDestinationSecretTypes)[number];

export const alertDestinations = pgTable(
  'alert_destinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: alertDestinationKinds }).notNull(),
    label: text('label').notNull(),
    /** The host, in the open. The full URL is a credential. */
    endpointHost: text('endpoint_host').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    status: text('status', { enum: alertDestinationStatuses }).notNull().default('unchecked'),
    statusReason: text('status_reason'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    /** Empty means every kind. A non-empty list narrows it. */
    eventAllowlist: text('event_allowlist').array().notNull().default([]),
    minSeverity: text('min_severity', { enum: alertSeverities }).notNull().default('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('alert_destinations_business_scoped').on(table.businessId, table.id),
    index('alert_destinations_by_business').on(table.businessId),
  ],
);

export type AlertDestination = typeof alertDestinations.$inferSelect;

export const alertDestinationSecrets = pgTable('alert_destination_secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull(),
  destinationId: uuid('destination_id').notNull(),
  secretType: text('secret_type', { enum: alertDestinationSecretTypes }).notNull(),
  ciphertext: text('ciphertext').notNull(),
  keyVersion: integer('key_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});

export type AlertDestinationSecret = typeof alertDestinationSecrets.$inferSelect;
