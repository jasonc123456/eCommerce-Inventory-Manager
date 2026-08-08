import {
  boolean,
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

import { canonicalItems, users } from './tenancy';

/**
 * Typed access to the kit tables (section 10).
 *
 * See `schema/tenancy.ts` for why the SQL migrations, not these definitions, are
 * the source of truth. The `is_kit` companion columns here are not data anyone
 * sets: they exist so a composite foreign key can require a component to be a
 * stocked item and a recipe's owner to be a kit.
 */

export const recipeStatuses = ['draft', 'active', 'superseded'] as const;
export type RecipeStatus = (typeof recipeStatuses)[number];

export const kitRecipes = pgTable(
  'kit_recipes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull(),
    /** The kit itself. */
    canonicalItemId: uuid('canonical_item_id').notNull(),
    /** Always true; the foreign key uses it to require a kit. */
    kitIsKit: boolean('kit_is_kit').notNull().default(true),
    version: integer('version').notNull(),
    status: text('status', { enum: recipeStatuses }).notNull().default('draft'),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('kit_recipes_version_unique').on(table.canonicalItemId, table.version),
    unique('kit_recipes_business_scoped').on(table.businessId, table.id),
    foreignKey({
      name: 'kit_recipes_kit_fkey',
      columns: [table.businessId, table.canonicalItemId, table.kitIsKit],
      foreignColumns: [canonicalItems.businessId, canonicalItems.id, canonicalItems.isKit],
    }).onDelete('cascade'),
    uniqueIndex('kit_recipes_one_active').on(table.canonicalItemId),
  ],
);

export const kitRecipeComponents = pgTable(
  'kit_recipe_components',
  {
    businessId: uuid('business_id').notNull(),
    recipeId: uuid('recipe_id').notNull(),
    /** Denormalized so the database can refuse a kit that contains itself. */
    kitCanonicalItemId: uuid('kit_canonical_item_id').notNull(),
    componentCanonicalItemId: uuid('component_canonical_item_id').notNull(),
    /** Always false; the foreign key uses it to refuse a kit as a component. */
    componentIsKit: boolean('component_is_kit').notNull().default(false),
    /** Positive whole number of component units consumed by one kit. */
    requiredQuantity: integer('required_quantity').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'kit_recipe_components_pkey',
      columns: [table.recipeId, table.componentCanonicalItemId],
    }),
    foreignKey({
      name: 'kit_recipe_components_recipe_fkey',
      columns: [table.businessId, table.recipeId],
      foreignColumns: [kitRecipes.businessId, kitRecipes.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'kit_recipe_components_component_fkey',
      columns: [table.businessId, table.componentCanonicalItemId, table.componentIsKit],
      foreignColumns: [canonicalItems.businessId, canonicalItems.id, canonicalItems.isKit],
    }).onDelete('restrict'),
    index('kit_recipe_components_by_component').on(
      table.businessId,
      table.componentCanonicalItemId,
    ),
  ],
);

export type KitRecipe = typeof kitRecipes.$inferSelect;
export type NewKitRecipe = typeof kitRecipes.$inferInsert;
export type KitRecipeComponent = typeof kitRecipeComponents.$inferSelect;
export type NewKitRecipeComponent = typeof kitRecipeComponents.$inferInsert;
