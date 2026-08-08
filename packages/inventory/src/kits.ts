import {
  canonicalItems,
  kitRecipeComponents,
  kitRecipes,
  locationBalances,
  locations,
  type Database,
  type RecipeStatus,
} from '@eim/db';
import { effectiveSafetyStock, kitAvailability, type LocationBalance } from '@eim/domain';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';

import { transactionally } from './ledger';
import { readSettings } from './settings';

/**
 * Fixed-quantity kits (section 10).
 *
 * A kit has no independent physical stock. Its availability is derived from its
 * components every time it is asked for, rather than stored and kept in step —
 * because a stored figure would be wrong for as long as it took something to
 * notice a component had moved, and section 10 requires a component sale to
 * recalculate affected kits *immediately*.
 *
 * The overlap this creates is deliberate and section 10 says so: a kit and one
 * of its own components may both be mapped, which advertises the same physical
 * units twice. `describeOverlap` is what the mapping workspace uses to warn at
 * approval time, naming the shared components rather than merely mentioning that
 * an overlap exists.
 */

export type KitReader = Pick<Database, 'select'>;
export type KitDatabase = Pick<Database, 'select' | 'transaction'>;

export interface RecipeComponent {
  readonly canonicalItemId: string;
  /** Positive whole number of component units consumed by one kit. */
  readonly requiredQuantity: number;
}

export interface RecipeSummary {
  readonly recipeId: string;
  readonly kitCanonicalItemId: string;
  readonly version: number;
  readonly status: RecipeStatus;
  readonly notes: string | null;
  readonly components: readonly (RecipeComponent & {
    readonly sku: string;
    readonly name: string;
  })[];
}

export type DeclareKitResult =
  | { readonly outcome: 'declared' }
  | { readonly outcome: 'not_found' }
  /** The item has stock history, so it cannot become a recipe (section 10). */
  | { readonly outcome: 'holds_stock' };

/**
 * Marks a canonical item as a kit.
 *
 * Refused for an item that has ever held stock. The database would refuse it
 * anyway — the composite foreign keys from the ledger require the item not to be
 * a kit — but a caught foreign-key error is a poor way to tell an operator that
 * they want a new item rather than a conversion.
 */
export async function declareKit(
  db: KitDatabase,
  input: { readonly businessId: string; readonly canonicalItemId: string },
): Promise<DeclareKitResult> {
  return transactionally<DeclareKitResult>(db, async (tx) => {
    const [item] = await tx
      .select({ isKit: canonicalItems.isKit })
      .from(canonicalItems)
      .where(
        and(
          eq(canonicalItems.businessId, input.businessId),
          eq(canonicalItems.id, input.canonicalItemId),
          isNull(canonicalItems.deletedAt),
        ),
      )
      .limit(1);

    if (item === undefined) {
      return { keep: false, value: { outcome: 'not_found' } };
    }
    if (item.isKit) {
      return { keep: true, value: { outcome: 'declared' } };
    }

    const held = await tx
      .select({ locationId: locationBalances.locationId })
      .from(locationBalances)
      .where(
        and(
          eq(locationBalances.businessId, input.businessId),
          eq(locationBalances.canonicalItemId, input.canonicalItemId),
        ),
      )
      .limit(1);

    if (held.length > 0) {
      return { keep: false, value: { outcome: 'holds_stock' } };
    }

    await tx
      .update(canonicalItems)
      .set({ isKit: true })
      .where(eq(canonicalItems.id, input.canonicalItemId));

    return { keep: true, value: { outcome: 'declared' } };
  });
}

export type DraftRecipeResult =
  | { readonly outcome: 'drafted'; readonly recipeId: string; readonly version: number }
  | { readonly outcome: 'not_a_kit' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Writes a new recipe version, in draft.
 *
 * Every change is a new version rather than an edit, because section 10 keeps
 * existing orders on the recipe that was active at purchase: a kit reversal six
 * weeks from now has to return the components that were actually taken, not the
 * ones the recipe names today.
 */
export async function draftRecipe(
  db: KitDatabase,
  input: {
    readonly businessId: string;
    readonly kitCanonicalItemId: string;
    readonly components: readonly RecipeComponent[];
    readonly notes?: string | null;
    readonly createdByUserId?: string | null;
  },
): Promise<DraftRecipeResult> {
  if (input.components.length === 0) {
    return { outcome: 'invalid', reason: 'a recipe needs at least one component' };
  }

  const seen = new Set<string>();
  for (const component of input.components) {
    if (!Number.isSafeInteger(component.requiredQuantity) || component.requiredQuantity < 1) {
      return {
        outcome: 'invalid',
        reason: 'each component consumes a whole positive number of units',
      };
    }
    if (component.canonicalItemId === input.kitCanonicalItemId) {
      return { outcome: 'invalid', reason: 'a kit cannot contain itself' };
    }
    if (seen.has(component.canonicalItemId)) {
      return { outcome: 'invalid', reason: 'a component appears more than once in the recipe' };
    }
    seen.add(component.canonicalItemId);
  }

  return transactionally<DraftRecipeResult>(db, async (tx) => {
    const [kit] = await tx
      .select({ isKit: canonicalItems.isKit })
      .from(canonicalItems)
      .where(
        and(
          eq(canonicalItems.businessId, input.businessId),
          eq(canonicalItems.id, input.kitCanonicalItemId),
        ),
      )
      .limit(1);

    if (kit?.isKit !== true) {
      return { keep: false, value: { outcome: 'not_a_kit' } };
    }

    // Section 10: components are existing canonical inventory items. A kit
    // among them would contribute no units, having none of its own.
    const components = await tx
      .select({ id: canonicalItems.id, isKit: canonicalItems.isKit })
      .from(canonicalItems)
      .where(
        and(
          eq(canonicalItems.businessId, input.businessId),
          inArray(canonicalItems.id, [...seen]),
          isNull(canonicalItems.deletedAt),
        ),
      );

    if (components.length !== seen.size) {
      return {
        keep: false,
        value: { outcome: 'invalid', reason: 'every component must be an item of this business' },
      };
    }
    if (components.some((component) => component.isKit)) {
      return {
        keep: false,
        value: {
          outcome: 'invalid',
          reason: 'a kit cannot be a component of another kit, having no stock of its own',
        },
      };
    }

    const [latest] = await tx
      .select({ version: kitRecipes.version })
      .from(kitRecipes)
      .where(eq(kitRecipes.canonicalItemId, input.kitCanonicalItemId))
      .orderBy(desc(kitRecipes.version))
      .limit(1);

    const version = (latest?.version ?? 0) + 1;

    const [recipe] = await tx
      .insert(kitRecipes)
      .values({
        businessId: input.businessId,
        canonicalItemId: input.kitCanonicalItemId,
        version,
        status: 'draft',
        notes: input.notes ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning({ id: kitRecipes.id });

    if (recipe === undefined) {
      throw new Error('the recipe could not be created');
    }

    await tx.insert(kitRecipeComponents).values(
      input.components.map((component) => ({
        businessId: input.businessId,
        recipeId: recipe.id,
        kitCanonicalItemId: input.kitCanonicalItemId,
        componentCanonicalItemId: component.canonicalItemId,
        requiredQuantity: component.requiredQuantity,
      })),
    );

    return { keep: true, value: { outcome: 'drafted', recipeId: recipe.id, version } };
  });
}

export type ApproveRecipeResult =
  | { readonly outcome: 'approved'; readonly supersededRecipeId: string | null }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'not_draft'; readonly status: RecipeStatus };

/**
 * Puts a drafted recipe in force, retiring the one it replaces.
 *
 * Section 10 requires a person: optional AI may suggest components and
 * quantities but cannot save or activate a recipe, so this takes an approver and
 * the database refuses an active recipe that names none.
 */
export async function approveRecipe(
  db: KitDatabase,
  input: {
    readonly businessId: string;
    readonly recipeId: string;
    readonly approvedByUserId: string;
    readonly now?: Date;
  },
): Promise<ApproveRecipeResult> {
  return transactionally<ApproveRecipeResult>(db, async (tx) => {
    const [recipe] = await tx
      .select({ status: kitRecipes.status, canonicalItemId: kitRecipes.canonicalItemId })
      .from(kitRecipes)
      .where(and(eq(kitRecipes.businessId, input.businessId), eq(kitRecipes.id, input.recipeId)))
      .limit(1);

    if (recipe === undefined) {
      return { keep: false, value: { outcome: 'not_found' } };
    }
    if (recipe.status !== 'draft') {
      return { keep: false, value: { outcome: 'not_draft', status: recipe.status } };
    }

    const superseded = await tx
      .update(kitRecipes)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(kitRecipes.canonicalItemId, recipe.canonicalItemId),
          eq(kitRecipes.status, 'active'),
        ),
      )
      .returning({ id: kitRecipes.id });

    await tx
      .update(kitRecipes)
      .set({
        status: 'active',
        approvedAt: input.now ?? new Date(),
        approvedByUserId: input.approvedByUserId,
      })
      .where(eq(kitRecipes.id, input.recipeId));

    return {
      keep: true,
      value: { outcome: 'approved', supersededRecipeId: superseded[0]?.id ?? null },
    };
  });
}

/** The recipe currently in force for one kit, if any. */
export async function readActiveRecipe(
  db: KitReader,
  input: { readonly businessId: string; readonly kitCanonicalItemId: string },
): Promise<RecipeSummary | null> {
  return readRecipeWhere(db, [
    eq(kitRecipes.businessId, input.businessId),
    eq(kitRecipes.canonicalItemId, input.kitCanonicalItemId),
    eq(kitRecipes.status, 'active'),
  ]);
}

/** A specific version, which is how a historical order is explained. */
export async function readRecipe(
  db: KitReader,
  input: { readonly businessId: string; readonly recipeId: string },
): Promise<RecipeSummary | null> {
  return readRecipeWhere(db, [
    eq(kitRecipes.businessId, input.businessId),
    eq(kitRecipes.id, input.recipeId),
  ]);
}

async function readRecipeWhere(
  db: KitReader,
  conditions: readonly ReturnType<typeof eq>[],
): Promise<RecipeSummary | null> {
  const [recipe] = await db
    .select({
      recipeId: kitRecipes.id,
      kitCanonicalItemId: kitRecipes.canonicalItemId,
      version: kitRecipes.version,
      status: kitRecipes.status,
      notes: kitRecipes.notes,
    })
    .from(kitRecipes)
    .where(and(...conditions))
    .limit(1);

  if (recipe === undefined) {
    return null;
  }

  const components = await db
    .select({
      canonicalItemId: kitRecipeComponents.componentCanonicalItemId,
      requiredQuantity: kitRecipeComponents.requiredQuantity,
      sku: canonicalItems.sku,
      name: canonicalItems.name,
    })
    .from(kitRecipeComponents)
    .innerJoin(canonicalItems, eq(canonicalItems.id, kitRecipeComponents.componentCanonicalItemId))
    .where(eq(kitRecipeComponents.recipeId, recipe.recipeId))
    .orderBy(asc(canonicalItems.sku));

  return { ...recipe, components };
}

export interface KitCapacity {
  readonly kitCanonicalItemId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  /** How many complete kits the components can currently supply. */
  readonly capacity: number;
  /** Whether components may be drawn from different locations (section 9). */
  readonly splitFulfillment: boolean;
  /** The component that is limiting capacity, for a UI that must explain zero. */
  readonly limitedBy: readonly { readonly canonicalItemId: string; readonly sku: string }[];
}

export type KitCapacityResult =
  | { readonly outcome: 'computed'; readonly capacity: KitCapacity }
  /** No recipe is in force, so the kit can supply nothing (section 10). */
  | { readonly outcome: 'no_active_recipe' };

/**
 * How many kits the components can currently make.
 *
 * Computed rather than stored. Section 10 recalculates affected kits on every
 * component movement, and a derived figure cannot be stale by construction —
 * whereas a stored one is wrong for however long it takes something to notice.
 *
 * The arithmetic itself lives in `@eim/domain`, where it is property-tested
 * without a database.
 */
export async function kitCapacity(
  db: KitReader,
  input: {
    readonly businessId: string;
    readonly kitCanonicalItemId: string;
    /** Restrict to these locations, as a mapping's selection does. */
    readonly locationIds?: readonly string[];
  },
): Promise<KitCapacityResult> {
  const recipe = await readActiveRecipe(db, input);

  if (recipe === null) {
    return { outcome: 'no_active_recipe' };
  }

  const settings = await readSettings(db, input.businessId);
  const componentIds = recipe.components.map((component) => component.canonicalItemId);

  const conditions = [
    eq(locationBalances.businessId, input.businessId),
    inArray(locationBalances.canonicalItemId, componentIds),
    isNull(locations.deletedAt),
    eq(locations.isActive, true),
  ];
  if (input.locationIds !== undefined) {
    conditions.push(inArray(locationBalances.locationId, [...input.locationIds]));
  }

  const rows = await db
    .select({
      canonicalItemId: locationBalances.canonicalItemId,
      locationId: locationBalances.locationId,
      onHand: locationBalances.onHand,
      reserved: locationBalances.reserved,
      locationOverride: locationBalances.safetyStock,
      itemOverride: canonicalItems.safetyStockOverride,
    })
    .from(locationBalances)
    .innerJoin(locations, eq(locations.id, locationBalances.locationId))
    .innerJoin(canonicalItems, eq(canonicalItems.id, locationBalances.canonicalItemId))
    .where(and(...conditions));

  const componentBalances = new Map<string, LocationBalance[]>();
  for (const row of rows) {
    const balances = componentBalances.get(row.canonicalItemId) ?? [];

    balances.push({
      locationId: row.locationId,
      onHand: row.onHand,
      reserved: row.reserved,
      // Section 10: kits inherit component safety stock and cannot consume
      // protected units.
      safetyStock: effectiveSafetyStock({
        businessDefault: settings.defaultSafetyStock,
        itemOverride: row.itemOverride,
        locationOverride: row.locationOverride,
      }),
    });
    componentBalances.set(row.canonicalItemId, balances);
  }

  const capacity = kitAvailability({
    components: recipe.components.map((component) => ({
      canonicalItemId: component.canonicalItemId,
      requiredQuantity: component.requiredQuantity,
    })),
    componentBalances,
    splitFulfillment: settings.splitFulfillment,
  });

  // Which component is holding the number down. Computed the same way, one
  // component at a time, so the explanation cannot disagree with the figure.
  const limitedBy = recipe.components
    .filter((component) => {
      const alone = kitAvailability({
        components: [
          {
            canonicalItemId: component.canonicalItemId,
            requiredQuantity: component.requiredQuantity,
          },
        ],
        componentBalances,
        splitFulfillment: settings.splitFulfillment,
      });

      return alone === capacity;
    })
    .map((component) => ({ canonicalItemId: component.canonicalItemId, sku: component.sku }));

  return {
    outcome: 'computed',
    capacity: {
      kitCanonicalItemId: input.kitCanonicalItemId,
      recipeId: recipe.recipeId,
      recipeVersion: recipe.version,
      capacity,
      splitFulfillment: settings.splitFulfillment,
      limitedBy,
    },
  };
}

export interface KitOverlap {
  readonly kitCanonicalItemId: string;
  readonly kitSku: string;
  readonly sharedComponents: readonly { readonly canonicalItemId: string; readonly sku: string }[];
}

/**
 * Which kits advertise the same physical units as this item (section 10).
 *
 * Section 10 permits a kit and one of its own components to both be mapped, and
 * states plainly that the sum of advertised availability then legitimately
 * exceeds physical stock. It also requires the mapping workspace to warn at
 * approval time and to *name the shared components*, which is the part that
 * makes this function necessary: "there is an overlap" tells an operator
 * nothing they can act on, while "these three kits also sell this bolt" does.
 */
export async function describeOverlap(
  db: KitReader,
  input: { readonly businessId: string; readonly canonicalItemId: string },
): Promise<KitOverlap[]> {
  const [item] = await db
    .select({ isKit: canonicalItems.isKit })
    .from(canonicalItems)
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        eq(canonicalItems.id, input.canonicalItemId),
      ),
    )
    .limit(1);

  if (item === undefined) {
    return [];
  }

  // A kit overlaps with every one of its own components; a component overlaps
  // with every kit that uses it. One query either way, differing only in which
  // side is held fixed.
  const componentIds = item.isKit
    ? ((
        await readActiveRecipe(db, { ...input, kitCanonicalItemId: input.canonicalItemId })
      )?.components.map((component) => component.canonicalItemId) ?? [])
    : [input.canonicalItemId];

  if (componentIds.length === 0) {
    return [];
  }

  const rows = await db
    .select({
      kitCanonicalItemId: kitRecipes.canonicalItemId,
      kitSku: canonicalItems.sku,
      componentCanonicalItemId: kitRecipeComponents.componentCanonicalItemId,
    })
    .from(kitRecipeComponents)
    .innerJoin(kitRecipes, eq(kitRecipes.id, kitRecipeComponents.recipeId))
    .innerJoin(canonicalItems, eq(canonicalItems.id, kitRecipes.canonicalItemId))
    .where(
      and(
        eq(kitRecipeComponents.businessId, input.businessId),
        eq(kitRecipes.status, 'active'),
        inArray(kitRecipeComponents.componentCanonicalItemId, componentIds),
        ne(kitRecipes.canonicalItemId, input.canonicalItemId),
      ),
    );

  const skus = await db
    .select({ id: canonicalItems.id, sku: canonicalItems.sku })
    .from(canonicalItems)
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        inArray(canonicalItems.id, componentIds),
      ),
    );
  const skuById = new Map(skus.map((row) => [row.id, row.sku]));

  const byKit = new Map<string, KitOverlap>();
  for (const row of rows) {
    const existing = byKit.get(row.kitCanonicalItemId) ?? {
      kitCanonicalItemId: row.kitCanonicalItemId,
      kitSku: row.kitSku,
      sharedComponents: [],
    };

    byKit.set(row.kitCanonicalItemId, {
      ...existing,
      sharedComponents: [
        ...existing.sharedComponents,
        {
          canonicalItemId: row.componentCanonicalItemId,
          sku: skuById.get(row.componentCanonicalItemId) ?? '',
        },
      ],
    });
  }

  return [...byKit.values()].sort((left, right) => left.kitSku.localeCompare(right.kitSku));
}

/** Every kit whose active recipe uses this component (section 10). */
export async function kitsUsingComponent(
  db: KitReader,
  input: { readonly businessId: string; readonly canonicalItemId: string },
): Promise<{ readonly kitCanonicalItemId: string; readonly requiredQuantity: number }[]> {
  return db
    .select({
      kitCanonicalItemId: kitRecipes.canonicalItemId,
      requiredQuantity: kitRecipeComponents.requiredQuantity,
    })
    .from(kitRecipeComponents)
    .innerJoin(kitRecipes, eq(kitRecipes.id, kitRecipeComponents.recipeId))
    .where(
      and(
        eq(kitRecipeComponents.businessId, input.businessId),
        eq(kitRecipeComponents.componentCanonicalItemId, input.canonicalItemId),
        eq(kitRecipes.status, 'active'),
      ),
    );
}
