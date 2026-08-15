import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { businesses, users } from './tenancy';

/**
 * Typed access to business deletion requests (sections 5, 13).
 *
 * `migrations/0035_business_deletion.sql` is the source of truth. The rules that
 * carry the guarantee — one outstanding request per business, a request settled
 * only once, and every settlement attributed — live only in the SQL.
 */

export const businessDeletionRequests = pgTable(
  'business_deletion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
  },
  (table) => [
    uniqueIndex('business_deletion_requests_token').on(table.tokenHash),
    index('business_deletion_requests_by_business').on(table.businessId, table.requestedAt),
  ],
);

export type BusinessDeletionRequest = typeof businessDeletionRequests.$inferSelect;
