import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { businesses, users } from './tenancy';

/**
 * Typed access to the connection tables (sections 13, 14).
 *
 * As everywhere else in this package, `migrations/0005_connections.sql` is the
 * source of truth and this file is the query surface over it. The composite
 * foreign keys, the partial unique indexes, and the checks that make an
 * inconsistent row unstorable live only in the SQL; the integration suite is
 * what proves they are still there.
 */

export const providerNames = ['ebay', 'woocommerce'] as const;
export const connectionEnvironments = ['sandbox', 'production'] as const;

export const connectionStatuses = [
  'pending',
  'active',
  'paused',
  'disconnected',
  'revoked',
] as const;

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: providerNames }).notNull(),
    environment: text('environment', { enum: connectionEnvironments }).notNull(),
    externalAccountId: text('external_account_id').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status', { enum: connectionStatuses }).notNull().default('pending'),
    pauseReason: text('pause_reason'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('connections_business_scoped').on(table.businessId, table.id),
    index('connections_business').on(table.businessId, table.provider, table.status),
  ],
);

export const connectionSecretTypes = [
  'ebay_refresh_token',
  'ebay_access_token',
  'woocommerce_consumer_key',
  'woocommerce_consumer_secret',
  'webhook_secret',
] as const;

export const connectionSecrets = pgTable(
  'connection_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    secretType: text('secret_type', { enum: connectionSecretTypes }).notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [index('connection_secrets_key_version').on(table.keyVersion)],
);

export const connectionScopes = pgTable(
  'connection_scopes',
  {
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    scope: text('scope').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.scope] })],
);

export const readinessStatuses = ['pass', 'warn', 'fail', 'unknown'] as const;

export const connectionReadinessChecks = pgTable(
  'connection_readiness_checks',
  {
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    checkName: text('check_name').notNull(),
    status: text('status', { enum: readinessStatuses }).notNull(),
    summary: text('summary').notNull(),
    detail: jsonb('detail').notNull().default({}),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.checkName] })],
);

export const healthStatuses = ['healthy', 'degraded', 'failing', 'unknown'] as const;

export const connectionHealth = pgTable(
  'connection_health',
  {
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    status: text('status', { enum: healthStatuses }).notNull().default('unknown'),
    summary: text('summary'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connectionId] })],
);

export const connectionCursors = pgTable(
  'connection_cursors',
  {
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    stream: text('stream').notNull(),
    cursorValue: text('cursor_value'),
    checkpoint: jsonb('checkpoint').notNull().default({}),
    lastCompleteAt: timestamp('last_complete_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.connectionId, table.stream] })],
);

export const importRunStatuses = ['running', 'completed', 'failed', 'cancelled'] as const;

export const importRuns = pgTable(
  'import_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    stream: text('stream').notNull(),
    status: text('status', { enum: importRunStatuses }).notNull().default('running'),
    sweptCompletely: boolean('swept_completely').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    recordsSeen: integer('records_seen').notNull().default(0),
    recordsWritten: integer('records_written').notNull().default(0),
    failureSummary: text('failure_summary'),
    checkpoint: jsonb('checkpoint').notNull().default({}),
  },
  (table) => [index('import_runs_recent').on(table.connectionId, table.stream, table.startedAt)],
);

export const webhookRegistrationStatuses = [
  'pending',
  'active',
  'paused',
  'replacing',
  'deleted',
  'failed',
] as const;

export const providerWebhooks = pgTable('provider_webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull(),
  connectionId: uuid('connection_id').notNull(),
  topic: text('topic').notNull(),
  externalId: text('external_id'),
  deliveryUrl: text('delivery_url').notNull(),
  appManaged: boolean('app_managed').notNull().default(true),
  status: text('status', { enum: webhookRegistrationStatuses }).notNull().default('pending'),
  secretId: uuid('secret_id').references(() => connectionSecrets.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
  failureCount: integer('failure_count').notNull().default(0),
});

export const webhookDeliveryStatuses = [
  'received',
  'processed',
  'ignored',
  'rejected',
  'failed',
] as const;

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
    topic: text('topic').notNull(),
    externalDeliveryId: text('external_delivery_id'),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    signatureVerified: boolean('signature_verified').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    status: text('status', { enum: webhookDeliveryStatuses }).notNull().default('received'),
    failureSummary: text('failure_summary'),
    rawBody: text('raw_body'),
    headers: jsonb('headers').notNull().default({}),
  },
  (table) => [index('webhook_deliveries_retention').on(table.receivedAt)],
);

export const providerQuotaWindows = pgTable(
  'provider_quota_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id'),
    connectionId: uuid('connection_id'),
    provider: text('provider', { enum: providerNames }).notNull(),
    apiFamily: text('api_family').notNull(),
    windowStartsAt: timestamp('window_starts_at', { withTimezone: true }).notNull(),
    windowEndsAt: timestamp('window_ends_at', { withTimezone: true }).notNull(),
    // `bigint` in the column, because a daily application-wide call allowance
    // is a number that grows with the installation rather than with one seller.
    limitCount: bigint('limit_count', { mode: 'number' }),
    usedCount: bigint('used_count', { mode: 'number' }).notNull().default(0),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The real index coalesces a null connection to a fixed uuid so that
    // application-level windows deduplicate too, which is not expressible here.
    // Declared for the shape it enforces; the migration is what enforces it.
    uniqueIndex('provider_quota_windows_unique').on(
      table.provider,
      table.apiFamily,
      table.connectionId,
      table.windowStartsAt,
    ),
  ],
);
