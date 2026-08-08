import {
  canonicalItems,
  kitRecipeComponents,
  kitRecipes,
  locationBalances,
  locations,
  reservationAllocations,
  stockReservations,
  type ConsumptionMode,
  type Database,
  type ReservationStatus,
} from '@eim/db';
import { effectiveSafetyStock, planAllocation, type AllocationComponent } from '@eim/domain';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { isUniqueViolation } from './errors';
import { lockBalances, lockOrder, postMovements, transactionally } from './ledger';
import { readSettings } from './settings';

/**
 * Committed demand: reserving it, consuming it, and giving it back (sections 9,
 * 10, 11, 12).
 *
 * Section 11's two consumption modes are the same act recorded two ways. Under
 * `reserve_until_fulfilled` the units stay on hand and are marked as spoken for,
 * so a shipment later moves them out; under `consume_immediately` they leave on
 * hand at once and there is no reserved balance to maintain. Everything else —
 * which locations, how much, what happens on cancellation — is identical, which
 * is why the mode is a stored fact on the reservation rather than a branch that
 * runs through every function here.
 *
 * The rule that shapes the error handling is section 11's: "record every valid
 * order even when insufficient stock exists." A line that cannot be filled does
 * not fail. It is recorded, the available units are allocated, and the shortage
 * is written down as its own number — because the customer has bought something
 * either way, and a reservation that refused to exist would leave the ledger
 * unable to explain why the storefront went to zero.
 */

export type ReservationDatabase = Pick<Database, 'select' | 'transaction'>;
export type ReservationReader = Pick<Database, 'select'>;

export interface ReserveInput {
  readonly businessId: string;
  readonly connectionId: string;
  readonly externalOrderId: string;
  readonly externalLineId: string;
  readonly canonicalItemId: string;
  readonly quantity: number;
  /** Restrict to a mapping's selected locations; otherwise every active one. */
  readonly locationIds?: readonly string[];
  readonly actorUserId?: string | null;
  readonly now?: Date;
}

export interface ReservationView {
  readonly reservationId: string;
  readonly status: ReservationStatus;
  readonly consumptionMode: ConsumptionMode;
  readonly quantity: number;
  readonly allocated: number;
  /** Section 11: what could not be supplied, recorded rather than negative. */
  readonly shortage: number;
  /** Section 9 owes a high-priority allocation conflict when this is true. */
  readonly splitBlocked: boolean;
  readonly allocations: readonly {
    readonly canonicalItemId: string;
    readonly locationId: string;
    readonly quantity: number;
  }[];
}

export type ReserveResult =
  | { readonly outcome: 'reserved'; readonly reservation: ReservationView }
  /** Section 12: a replayed event returns the prior outcome, mutating nothing. */
  | { readonly outcome: 'already_recorded'; readonly reservation: ReservationView }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Records demand against the ledger.
 *
 * Idempotent on the order line, which is the unit a provider redelivers. The
 * unique index does the enforcing; this catches its violation and answers with
 * what was recorded the first time, because section 12 requires a replayed event
 * to return the prior outcome rather than a second decrement.
 */
export async function reserve(
  db: ReservationDatabase,
  input: ReserveInput,
): Promise<ReserveResult> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    return { outcome: 'invalid', reason: 'an order line is a whole positive number of units' };
  }

  const existing = await readReservationByLine(db, input);
  if (existing !== null) {
    return { outcome: 'already_recorded', reservation: existing };
  }

  try {
    return await transactionally<ReserveResult>(db, async (tx) => {
      const settings = await readSettings(tx, input.businessId);
      const expansion = await expand(tx, input);

      if (expansion === null) {
        return { keep: false, value: { outcome: 'not_found' } };
      }

      const order = await eligibleLocations(tx, input);

      // Lock every balance this line could draw on, in the sorted order every
      // other posting uses, *before* reading how much is available. Without
      // this, two orders for the last unit both read one available and both
      // reserve it; the database would refuse the second write, but as an
      // error rather than as the shortage section 11 asks for. Absent rows are
      // not locked and do not need to be: a location with no row has nothing to
      // give, and a concurrent receipt that creates one can only add stock.
      await lockBalances(
        tx,
        input.businessId,
        lockOrder(
          expansion.components.flatMap((component) =>
            order.map((locationId) => ({
              canonicalItemId: component.canonicalItemId,
              locationId,
            })),
          ),
        ),
      );

      const available = await availableByItem(tx, {
        businessId: input.businessId,
        canonicalItemIds: expansion.components.map((component) => component.canonicalItemId),
        locationIds: order,
        defaultSafetyStock: settings.defaultSafetyStock,
      });

      const plan = planAllocation({
        quantity: input.quantity,
        components: expansion.components,
        locationOrder: order,
        available,
        splitFulfillment: settings.splitFulfillment,
      });

      const [reservation] = await tx
        .insert(stockReservations)
        .values({
          businessId: input.businessId,
          connectionId: input.connectionId,
          externalOrderId: input.externalOrderId,
          externalLineId: input.externalLineId,
          canonicalItemId: input.canonicalItemId,
          quantity: input.quantity,
          consumptionMode: settings.consumptionMode,
          kitRecipeId: expansion.recipeId,
          shortage: plan.shortage,
          splitBlocked: plan.splitBlocked,
          status: 'open',
        })
        .returning({ id: stockReservations.id });

      if (reservation === undefined) {
        throw new Error('the reservation could not be created');
      }

      const entryByTake = new Map<string, string>();

      if (settings.consumptionMode === 'consume_immediately' && plan.takes.length > 0) {
        // Section 11: a qualifying order immediately decreases on-hand, and no
        // separate reserved balance is maintained for it.
        const posted = await postMovements(tx, {
          businessId: input.businessId,
          actorUserId: input.actorUserId ?? null,
          ...(input.now === undefined ? {} : { occurredAt: input.now }),
          movements: plan.takes.map((take) => ({
            canonicalItemId: take.canonicalItemId,
            locationId: take.locationId,
            kind: 'shipment' as const,
            quantityDelta: -take.quantity,
            reason: `order ${input.externalOrderId} line ${input.externalLineId}`,
          })),
        });

        if (posted.outcome !== 'posted') {
          return {
            keep: false,
            value: {
              outcome: 'invalid',
              reason:
                posted.outcome === 'insufficient'
                  ? 'the units moved while the order was being recorded'
                  : posted.reason,
            },
          };
        }

        plan.takes.forEach((take, index) => {
          const entryId = posted.entryIds[index];
          if (entryId !== undefined) {
            entryByTake.set(`${take.canonicalItemId}:${take.locationId}`, entryId);
          }
        });
      } else if (plan.takes.length > 0) {
        // Reserving is not a stock movement, so it writes no ledger entry. The
        // units are still there; they are merely spoken for.
        await addReserved(tx, input.businessId, plan.takes);
      }

      if (plan.takes.length > 0) {
        await tx.insert(reservationAllocations).values(
          plan.takes.map((take) => ({
            businessId: input.businessId,
            reservationId: reservation.id,
            canonicalItemId: take.canonicalItemId,
            locationId: take.locationId,
            quantity: take.quantity,
            ledgerEntryId: entryByTake.get(`${take.canonicalItemId}:${take.locationId}`) ?? null,
          })),
        );
      }

      return {
        keep: true,
        value: {
          outcome: 'reserved',
          reservation: {
            reservationId: reservation.id,
            status: 'open',
            consumptionMode: settings.consumptionMode,
            quantity: input.quantity,
            allocated: plan.allocated,
            shortage: plan.shortage,
            splitBlocked: plan.splitBlocked,
            allocations: plan.takes,
          },
        },
      };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'stock_reservations_line_unique')) {
      const recorded = await readReservationByLine(db, input);

      return recorded === null
        ? { outcome: 'invalid', reason: 'that order line is already recorded' }
        : { outcome: 'already_recorded', reservation: recorded };
    }

    throw error;
  }
}

export type FulfillResult =
  | { readonly outcome: 'fulfilled' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'already_resolved'; readonly status: ReservationStatus }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Ships the reserved units: they leave on hand and stop being reserved.
 *
 * Under `consume_immediately` they left at the moment of the order, so this only
 * marks the reservation resolved. Both paths end in the same state, which is
 * what lets the rest of the system stop caring which mode a business is in.
 */
export async function fulfillReservation(
  db: ReservationDatabase,
  input: {
    readonly businessId: string;
    readonly reservationId: string;
    readonly actorUserId?: string | null;
    readonly now?: Date;
  },
): Promise<FulfillResult> {
  return transactionally<FulfillResult>(db, async (tx) => {
    const held = await readForResolution(tx, input.businessId, input.reservationId);

    if (held === null) {
      return { keep: false, value: { outcome: 'not_found' } };
    }
    if (held.status !== 'open') {
      return { keep: false, value: { outcome: 'already_resolved', status: held.status } };
    }

    if (held.consumptionMode === 'reserve_until_fulfilled' && held.allocations.length > 0) {
      const posted = await postMovements(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId ?? null,
        ...(input.now === undefined ? {} : { occurredAt: input.now }),
        movements: held.allocations.map((allocation) => ({
          canonicalItemId: allocation.canonicalItemId,
          locationId: allocation.locationId,
          kind: 'shipment' as const,
          quantityDelta: -allocation.quantity,
          reason: `shipped against reservation ${input.reservationId}`,
        })),
      });

      if (posted.outcome !== 'posted') {
        return {
          keep: false,
          value: {
            outcome: 'invalid',
            reason:
              posted.outcome === 'insufficient'
                ? 'the reserved units are no longer there'
                : posted.reason,
          },
        };
      }

      // Released after the movement, not before: the balance check requires
      // reserved units to stay inside on-hand, and the two must agree at every
      // point the database is allowed to look.
      await releaseReserved(tx, input.businessId, held.allocations);
    }

    await tx
      .update(stockReservations)
      .set({ status: 'consumed', resolvedAt: input.now ?? new Date() })
      .where(eq(stockReservations.id, input.reservationId));

    return { keep: true, value: { outcome: 'fulfilled' } };
  });
}

export type ReleaseResult =
  | { readonly outcome: 'released'; readonly restored: number }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'already_resolved'; readonly status: ReservationStatus }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Cancels before shipment, putting the units back where they came from.
 *
 * Section 11: "pre-shipment cancellation releases reservations or restores
 * immediately consumed quantities to their original allocations." The original
 * allocations are read from the rows rather than recomputed, because by now
 * priority may have changed and stock has certainly moved — recomputing would
 * put the units somewhere they never were.
 *
 * A restored consumption is written as a reversal of the entry that consumed it,
 * so the timeline reads as one event corrected rather than as a sale followed by
 * an unexplained delivery.
 */
export async function releaseReservation(
  db: ReservationDatabase,
  input: {
    readonly businessId: string;
    readonly reservationId: string;
    readonly reason: string;
    readonly actorUserId?: string | null;
    readonly now?: Date;
  },
): Promise<ReleaseResult> {
  if (input.reason.trim().length === 0) {
    return { outcome: 'invalid', reason: 'releasing a reservation needs a stated reason' };
  }

  return transactionally<ReleaseResult>(db, async (tx) => {
    const held = await readForResolution(tx, input.businessId, input.reservationId);

    if (held === null) {
      return { keep: false, value: { outcome: 'not_found' } };
    }
    if (held.status !== 'open') {
      return { keep: false, value: { outcome: 'already_resolved', status: held.status } };
    }

    let restored = 0;

    if (held.consumptionMode === 'consume_immediately') {
      const reversible = held.allocations.filter(
        (allocation): allocation is typeof allocation & { ledgerEntryId: string } =>
          allocation.ledgerEntryId !== null,
      );

      if (reversible.length > 0) {
        const posted = await postMovements(tx, {
          businessId: input.businessId,
          actorUserId: input.actorUserId ?? null,
          ...(input.now === undefined ? {} : { occurredAt: input.now }),
          movements: reversible.map((allocation) => ({
            canonicalItemId: allocation.canonicalItemId,
            locationId: allocation.locationId,
            kind: 'reversal' as const,
            quantityDelta: allocation.quantity,
            reversalOfId: allocation.ledgerEntryId,
            reason: input.reason.trim(),
          })),
        });

        if (posted.outcome !== 'posted') {
          return {
            keep: false,
            value: {
              outcome: 'invalid',
              reason:
                posted.outcome === 'insufficient'
                  ? 'the units could not be restored'
                  : posted.reason,
            },
          };
        }
      }

      restored = reversible.reduce((total, allocation) => total + allocation.quantity, 0);
    } else if (held.allocations.length > 0) {
      await releaseReserved(tx, input.businessId, held.allocations);
      restored = held.allocations.reduce((total, allocation) => total + allocation.quantity, 0);
    }

    await tx
      .update(stockReservations)
      .set({
        status: 'released',
        releasedReason: input.reason.trim(),
        resolvedAt: input.now ?? new Date(),
      })
      .where(eq(stockReservations.id, input.reservationId));

    return { keep: true, value: { outcome: 'released', restored } };
  });
}

export interface ModeSwitchPreview {
  readonly from: ConsumptionMode;
  readonly to: ConsumptionMode;
  /** Section 11 blocks on these unless the caller confirms a migration. */
  readonly openReservations: number;
  readonly reservedUnits: number;
}

export type ModeSwitchResult =
  | { readonly outcome: 'switched' }
  | { readonly outcome: 'unchanged' }
  /** Open reservations exist and no migration was confirmed (section 11). */
  | { readonly outcome: 'needs_migration'; readonly preview: ModeSwitchPreview };

/** What switching consumption mode would mean, without switching it. */
export async function previewModeSwitch(
  db: ReservationReader,
  input: { readonly businessId: string; readonly to: ConsumptionMode },
): Promise<ModeSwitchPreview> {
  const settings = await readSettings(db, input.businessId);

  const open = await db
    .select({
      reservationId: stockReservations.id,
      quantity: reservationAllocations.quantity,
    })
    .from(stockReservations)
    .leftJoin(
      reservationAllocations,
      eq(reservationAllocations.reservationId, stockReservations.id),
    )
    .where(
      and(eq(stockReservations.businessId, input.businessId), eq(stockReservations.status, 'open')),
    );

  return {
    from: settings.consumptionMode,
    to: input.to,
    openReservations: new Set(open.map((row) => row.reservationId)).size,
    reservedUnits: open.reduce((total, row) => total + (row.quantity ?? 0), 0),
  };
}

/**
 * Switches the consumption mode, migrating what is open if told to.
 *
 * Section 11 requires an impact preview and either no open reservations or a
 * confirmed migration. Migrating means moving the open reservations onto the new
 * mode: reserved units are consumed, or consumed units are put back and reserved
 * instead. Both are real stock movements, which is exactly why the spec will not
 * let this happen without someone agreeing to it.
 */
export async function switchConsumptionMode(
  db: ReservationDatabase,
  input: {
    readonly businessId: string;
    readonly to: ConsumptionMode;
    readonly migrateOpenReservations?: boolean;
    readonly actorUserId?: string | null;
    readonly now?: Date;
  },
): Promise<ModeSwitchResult> {
  const preview = await previewModeSwitch(db, input);

  if (preview.from === input.to) {
    return { outcome: 'unchanged' };
  }
  if (preview.openReservations > 0 && input.migrateOpenReservations !== true) {
    return { outcome: 'needs_migration', preview };
  }

  const open = await db
    .select({ id: stockReservations.id })
    .from(stockReservations)
    .where(
      and(eq(stockReservations.businessId, input.businessId), eq(stockReservations.status, 'open')),
    );

  for (const reservation of open) {
    await migrateReservation(db, {
      businessId: input.businessId,
      reservationId: reservation.id,
      to: input.to,
      actorUserId: input.actorUserId ?? null,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into business_inventory_settings (business_id, consumption_mode)
      values (${input.businessId}, ${input.to})
      on conflict (business_id)
        do update set consumption_mode = excluded.consumption_mode, updated_at = now()
    `);
  });

  return { outcome: 'switched' };
}

/** Moves one open reservation onto the other mode, as a real stock movement. */
async function migrateReservation(
  db: ReservationDatabase,
  input: {
    readonly businessId: string;
    readonly reservationId: string;
    readonly to: ConsumptionMode;
    readonly actorUserId: string | null;
    readonly now?: Date;
  },
): Promise<void> {
  await transactionally<null>(db, async (tx) => {
    const held = await readForResolution(tx, input.businessId, input.reservationId);

    const migratable = held?.status === 'open' && held.consumptionMode !== input.to;

    if (held === null || !migratable) {
      return { keep: false, value: null };
    }
    if (held.allocations.length === 0) {
      await tx
        .update(stockReservations)
        .set({ consumptionMode: input.to })
        .where(eq(stockReservations.id, input.reservationId));

      return { keep: true, value: null };
    }

    if (input.to === 'consume_immediately') {
      const posted = await postMovements(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        ...(input.now === undefined ? {} : { occurredAt: input.now }),
        movements: held.allocations.map((allocation) => ({
          canonicalItemId: allocation.canonicalItemId,
          locationId: allocation.locationId,
          kind: 'shipment' as const,
          quantityDelta: -allocation.quantity,
          reason: `consumption mode migration for reservation ${input.reservationId}`,
        })),
      });

      if (posted.outcome !== 'posted') {
        return { keep: false, value: null };
      }

      await releaseReserved(tx, input.businessId, held.allocations);

      for (const [index, allocation] of held.allocations.entries()) {
        await tx
          .update(reservationAllocations)
          .set({ ledgerEntryId: posted.entryIds[index] ?? null })
          .where(eq(reservationAllocations.id, allocation.allocationId));
      }
    } else {
      const reversible = held.allocations.filter(
        (allocation): allocation is typeof allocation & { ledgerEntryId: string } =>
          allocation.ledgerEntryId !== null,
      );

      if (reversible.length > 0) {
        const posted = await postMovements(tx, {
          businessId: input.businessId,
          actorUserId: input.actorUserId,
          ...(input.now === undefined ? {} : { occurredAt: input.now }),
          movements: reversible.map((allocation) => ({
            canonicalItemId: allocation.canonicalItemId,
            locationId: allocation.locationId,
            kind: 'reversal' as const,
            quantityDelta: allocation.quantity,
            reversalOfId: allocation.ledgerEntryId,
            reason: `consumption mode migration for reservation ${input.reservationId}`,
          })),
        });

        if (posted.outcome !== 'posted') {
          return { keep: false, value: null };
        }
      }

      await addReserved(tx, input.businessId, held.allocations);
      await tx
        .update(reservationAllocations)
        .set({ ledgerEntryId: null })
        .where(eq(reservationAllocations.reservationId, input.reservationId));
    }

    await tx
      .update(stockReservations)
      .set({ consumptionMode: input.to })
      .where(eq(stockReservations.id, input.reservationId));

    return { keep: true, value: null };
  });
}

/** One reservation as an operator sees it, allocations included. */
export async function readReservation(
  db: ReservationReader,
  input: { readonly businessId: string; readonly reservationId: string },
): Promise<ReservationView | null> {
  const [row] = await db
    .select({
      reservationId: stockReservations.id,
      status: stockReservations.status,
      consumptionMode: stockReservations.consumptionMode,
      quantity: stockReservations.quantity,
      shortage: stockReservations.shortage,
      splitBlocked: stockReservations.splitBlocked,
    })
    .from(stockReservations)
    .where(
      and(
        eq(stockReservations.businessId, input.businessId),
        eq(stockReservations.id, input.reservationId),
      ),
    )
    .limit(1);

  if (row === undefined) {
    return null;
  }

  const allocations = await db
    .select({
      canonicalItemId: reservationAllocations.canonicalItemId,
      locationId: reservationAllocations.locationId,
      quantity: reservationAllocations.quantity,
    })
    .from(reservationAllocations)
    .where(eq(reservationAllocations.reservationId, input.reservationId));

  return { ...row, allocated: row.quantity - row.shortage, allocations };
}

async function readReservationByLine(
  db: ReservationReader,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly externalOrderId: string;
    readonly externalLineId: string;
  },
): Promise<ReservationView | null> {
  const [row] = await db
    .select({ id: stockReservations.id })
    .from(stockReservations)
    .where(
      and(
        eq(stockReservations.connectionId, input.connectionId),
        eq(stockReservations.externalOrderId, input.externalOrderId),
        eq(stockReservations.externalLineId, input.externalLineId),
      ),
    )
    .limit(1);

  return row === undefined
    ? null
    : readReservation(db, { businessId: input.businessId, reservationId: row.id });
}

interface HeldReservation {
  readonly status: ReservationStatus;
  readonly consumptionMode: ConsumptionMode;
  readonly allocations: readonly {
    readonly allocationId: string;
    readonly canonicalItemId: string;
    readonly locationId: string;
    readonly quantity: number;
    readonly ledgerEntryId: string | null;
  }[];
}

/**
 * Reads a reservation and locks the balances its allocations name.
 *
 * The balances are locked in the same sorted order every other posting uses, so
 * a shipment and a concurrent adjustment on the same shelf cannot deadlock.
 */
async function readForResolution(
  tx: Parameters<typeof lockBalances>[0],
  businessId: string,
  reservationId: string,
): Promise<HeldReservation | null> {
  const [row] = await tx
    .select({
      status: stockReservations.status,
      consumptionMode: stockReservations.consumptionMode,
    })
    .from(stockReservations)
    .where(
      and(eq(stockReservations.businessId, businessId), eq(stockReservations.id, reservationId)),
    )
    .limit(1);

  if (row === undefined) {
    return null;
  }

  const allocations = await tx
    .select({
      allocationId: reservationAllocations.id,
      canonicalItemId: reservationAllocations.canonicalItemId,
      locationId: reservationAllocations.locationId,
      quantity: reservationAllocations.quantity,
      ledgerEntryId: reservationAllocations.ledgerEntryId,
    })
    .from(reservationAllocations)
    .where(eq(reservationAllocations.reservationId, reservationId));

  await lockBalances(tx, businessId, lockOrder(allocations));

  return { ...row, allocations };
}

/** What one ordered unit consumes, and the recipe that said so. */
interface Expansion {
  readonly components: readonly AllocationComponent[];
  readonly recipeId: string | null;
}

async function expand(
  tx: ReservationReader,
  input: { readonly businessId: string; readonly canonicalItemId: string },
): Promise<Expansion | null> {
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
    return null;
  }
  if (!item.isKit) {
    return {
      components: [{ canonicalItemId: input.canonicalItemId, unitsPerOrderedUnit: 1 }],
      recipeId: null,
    };
  }

  const [recipe] = await tx
    .select({ id: kitRecipes.id })
    .from(kitRecipes)
    .where(
      and(
        eq(kitRecipes.businessId, input.businessId),
        eq(kitRecipes.canonicalItemId, input.canonicalItemId),
        eq(kitRecipes.status, 'active'),
      ),
    )
    .limit(1);

  if (recipe === undefined) {
    return null;
  }

  const components = await tx
    .select({
      canonicalItemId: kitRecipeComponents.componentCanonicalItemId,
      unitsPerOrderedUnit: kitRecipeComponents.requiredQuantity,
    })
    .from(kitRecipeComponents)
    .where(eq(kitRecipeComponents.recipeId, recipe.id));

  return { components, recipeId: recipe.id };
}

async function eligibleLocations(
  tx: ReservationReader,
  input: { readonly businessId: string; readonly locationIds?: readonly string[] },
): Promise<string[]> {
  const conditions = [
    eq(locations.businessId, input.businessId),
    eq(locations.isActive, true),
    isNull(locations.deletedAt),
  ];
  if (input.locationIds !== undefined) {
    conditions.push(inArray(locations.id, [...input.locationIds]));
  }

  const rows = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(...conditions))
    .orderBy(asc(locations.priority), asc(locations.code));

  return rows.map((row) => row.id);
}

async function availableByItem(
  tx: ReservationReader,
  input: {
    readonly businessId: string;
    readonly canonicalItemIds: readonly string[];
    readonly locationIds: readonly string[];
    readonly defaultSafetyStock: number;
  },
): Promise<Map<string, Map<string, number>>> {
  const available = new Map<string, Map<string, number>>();

  if (input.canonicalItemIds.length === 0 || input.locationIds.length === 0) {
    return available;
  }

  const rows = await tx
    .select({
      canonicalItemId: locationBalances.canonicalItemId,
      locationId: locationBalances.locationId,
      onHand: locationBalances.onHand,
      reserved: locationBalances.reserved,
      locationOverride: locationBalances.safetyStock,
      itemOverride: canonicalItems.safetyStockOverride,
    })
    .from(locationBalances)
    .innerJoin(canonicalItems, eq(canonicalItems.id, locationBalances.canonicalItemId))
    .where(
      and(
        eq(locationBalances.businessId, input.businessId),
        inArray(locationBalances.canonicalItemId, [...input.canonicalItemIds]),
        inArray(locationBalances.locationId, [...input.locationIds]),
      ),
    );

  for (const row of rows) {
    const byLocation = available.get(row.canonicalItemId) ?? new Map<string, number>();

    byLocation.set(
      row.locationId,
      Math.max(
        0,
        row.onHand -
          row.reserved -
          effectiveSafetyStock({
            businessDefault: input.defaultSafetyStock,
            itemOverride: row.itemOverride,
            locationOverride: row.locationOverride,
          }),
      ),
    );
    available.set(row.canonicalItemId, byLocation);
  }

  return available;
}

async function addReserved(
  tx: Pick<Database, 'execute'>,
  businessId: string,
  takes: readonly {
    readonly canonicalItemId: string;
    readonly locationId: string;
    readonly quantity: number;
  }[],
): Promise<void> {
  for (const take of takes) {
    await tx.execute(sql`
      update location_balances
         set reserved = reserved + ${take.quantity}, updated_at = now()
       where business_id = ${businessId}
         and canonical_item_id = ${take.canonicalItemId}
         and location_id = ${take.locationId}
    `);
  }
}

async function releaseReserved(
  tx: Pick<Database, 'execute'>,
  businessId: string,
  takes: readonly {
    readonly canonicalItemId: string;
    readonly locationId: string;
    readonly quantity: number;
  }[],
): Promise<void> {
  for (const take of takes) {
    await tx.execute(sql`
      update location_balances
         set reserved = greatest(0, reserved - ${take.quantity}), updated_at = now()
       where business_id = ${businessId}
         and canonical_item_id = ${take.canonicalItemId}
         and location_id = ${take.locationId}
    `);
  }
}

/** Every open reservation drawing on one item, for a preview or a conflict. */
export async function openReservationsForItem(
  db: ReservationReader,
  input: { readonly businessId: string; readonly canonicalItemId: string },
): Promise<{ readonly reservationId: string; readonly quantity: number }[]> {
  return db
    .select({
      reservationId: stockReservations.id,
      quantity: reservationAllocations.quantity,
    })
    .from(reservationAllocations)
    .innerJoin(stockReservations, eq(stockReservations.id, reservationAllocations.reservationId))
    .where(
      and(
        eq(reservationAllocations.businessId, input.businessId),
        eq(reservationAllocations.canonicalItemId, input.canonicalItemId),
        eq(stockReservations.status, 'open'),
      ),
    );
}
