import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { operatorAlerts } from './alerts';
import { businesses, users } from './tenancy';

/**
 * Typed access to notification deliveries (sections 20, 22).
 *
 * `migrations/0027_notification_deliveries.sql` is the source of truth. What is
 * not expressible here is the unique index on the idempotency key, which is the
 * only thing standing between a retried sweep and a second message.
 */

export const notificationChannels = ['in_app', 'email'] as const;
export type NotificationChannelName = (typeof notificationChannels)[number];

/**
 * `suppressed` is a decision not to send, recorded rather than skipped.
 *
 * "Why did nobody get told" is a question asked after something has already
 * gone wrong, and the answer has to be in the history rather than inferable
 * from the absence of a row.
 */
export const deliveryStatuses = ['pending', 'sent', 'failed', 'deferred', 'suppressed'] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    alertId: uuid('alert_id')
      .notNull()
      .references(() => operatorAlerts.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: notificationChannels }).notNull(),
    recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Derived from the alert, channel, recipient, and reminder count. */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', { enum: deliveryStatuses }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    deferredUntil: timestamp('deferred_until', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Bounded and non-sensitive; never the transport's own error text. */
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('notification_deliveries_once_per_key').on(table.idempotencyKey),
    index('notification_deliveries_by_alert').on(table.alertId, table.createdAt),
  ],
);

export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
