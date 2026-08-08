import { relations } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** A PostgreSQL text array, typed as `string[]` rather than `unknown[]`. */
const textArray = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => 'text[]',
});

/**
 * Typed access to the tenancy tables.
 *
 * The SQL in `migrations/` is the source of truth for the schema; this file is
 * the query surface over it. Drizzle is used as a typed query builder, not as a
 * schema generator, because section 17 needs composite foreign keys, scoped
 * partial unique indexes, CHECK constraints, and constraint triggers, and a
 * generator that can only express a subset of those would quietly become the
 * thing deciding what the schema is allowed to contain.
 *
 * The two are kept honest by integration tests that write through these
 * definitions against a database built by the migrations. A column declared
 * here that the migration never created fails there.
 */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    /** What the user actually typed, for addressing mail (section 19). */
    emailDisplay: text('email_display'),
    displayName: text('display_name'),
    status: text('status', { enum: ['active', 'suspended', 'deleted'] })
      .notNull()
      .default('active'),
    /** Installation-level suspension. Revokes every session everywhere. */
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspendedReason: text('suspended_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
);

export const businesses = pgTable(
  'businesses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** D-136: quiet hours and the nightly window are business-level concepts. */
    timezone: text('timezone').notNull().default('UTC'),
    /** Empty means no restriction, which must stay distinguishable from
     * "restricted to nothing" (section 20). */
    allowedEmailDomains: textArray('allowed_email_domains').notNull().default([]),
    /** Roles for which the owner requires a second factor (section 20). */
    requireTwoFactorRoles: textArray('require_two_factor_roles').notNull().default([]),
    status: text('status', { enum: ['active', 'suspended', 'deleted'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('businesses_slug_unique').on(table.slug)],
);

export const membershipRoles = ['owner', 'manager', 'operator', 'viewer'] as const;
export type MembershipRole = (typeof membershipRoles)[number];

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role', { enum: membershipRoles }).notNull(),
    /** Suspension removes this business's access without touching the user's
     * account or their other businesses (section 20). */
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('memberships_unique_per_user').on(table.businessId, table.userId),
    // Carries business_id through a foreign key, as locations do. Permission
    // grants depend on it.
    unique('memberships_business_scoped').on(table.businessId, table.id),
    index('memberships_user_idx').on(table.userId),
  ],
);

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    timezone: text('timezone').notNull().default('UTC'),
    /** Allocation order. Lower sorts first; ties break by code (section 9). */
    priority: integer('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    // The composite unique that lets other tables carry business_id through a
    // foreign key. See migrations/0001_foundation.sql.
    unique('locations_business_scoped').on(table.businessId, table.id),
  ],
);

export const canonicalItems = pgTable(
  'canonical_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * Per-item safety stock, including zero, overriding the business default
     * (section 8). Null inherits; a stored 0 withholds nothing deliberately.
     */
    safetyStockOverride: integer('safety_stock_override'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [unique('canonical_items_business_scoped').on(table.businessId, table.id)],
);

export const businessesRelations = relations(businesses, ({ many }) => ({
  memberships: many(memberships),
  locations: many(locations),
  canonicalItems: many(canonicalItems),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  business: one(businesses, { fields: [memberships.businessId], references: [businesses.id] }),
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Business = typeof businesses.$inferSelect;
export type NewBusiness = typeof businesses.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
export type CanonicalItem = typeof canonicalItems.$inferSelect;
export type NewCanonicalItem = typeof canonicalItems.$inferInsert;
