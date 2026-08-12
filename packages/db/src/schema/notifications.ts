import { index, pgTable, text, time, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { businesses, users } from './tenancy';

/**
 * Typed access to notification routing (sections 5, 9, 22).
 *
 * `migrations/0026_notification_routing.sql` is the source of truth. What is
 * not expressible here is the check that a kind cannot be both opted into and
 * muted, which is the one a form can violate by accident.
 */

/**
 * The floor at which email is sent.
 *
 * `none` is not a severity — it is the absence of one, and it exists so that
 * switching email off is a value rather than a null that also means "never
 * configured". Section 22 keeps the in-app list regardless: an alert stops
 * arriving, it does not stop being visible.
 */
export const emailSeverityFloors = ['info', 'warning', 'error', 'critical', 'none'] as const;
export type EmailSeverityFloor = (typeof emailSeverityFloors)[number];

export const businessNotificationSettings = pgTable('business_notification_settings', {
  businessId: uuid('business_id')
    .primaryKey()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  /** Local wall-clock in `businesses.timezone`. Null means no quiet hours. */
  quietHoursStart: time('quiet_hours_start'),
  quietHoursEnd: time('quiet_hours_end'),
  /** Where a critical alert goes when no permitted member is left. */
  fallbackEmail: text('fallback_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BusinessNotificationSettings = typeof businessNotificationSettings.$inferSelect;

export const userNotificationPreferences = pgTable(
  'user_notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailMinSeverity: text('email_min_severity', { enum: emailSeverityFloors })
      .notNull()
      .default('error'),
    emailOptedInKinds: text('email_opted_in_kinds').array().notNull().default([]),
    emailMutedKinds: text('email_muted_kinds').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('user_notification_preferences_one_per_membership').on(table.businessId, table.userId),
    index('user_notification_preferences_by_business').on(table.businessId),
  ],
);

export type UserNotificationPreference = typeof userNotificationPreferences.$inferSelect;
