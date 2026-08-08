import {
  locationAddresses,
  locationBalances,
  locationChannelLinks,
  locations,
  type AddressPurpose,
  type Database,
} from '@eim/db';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';

import { isUniqueViolation } from './errors';

/**
 * Locations as real inventory pools (section 9).
 *
 * Section 9's first sentence is the one that shapes this module: locations are
 * pools, not tags. Everything here follows from stock actually sitting
 * somewhere — a location cannot be archived while it holds units, a location
 * has an allocation priority because a sale has to pick one, and the link to a
 * provider's own merchant location identifier is written down rather than
 * guessed at.
 */

export type LocationReader = Pick<Database, 'select'>;
export type LocationWriter = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

export interface LocationSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly timezone: string;
  readonly priority: number;
  readonly isActive: boolean;
}

/**
 * Every location of a business in allocation order.
 *
 * Priority first, then code. The tiebreak matters: allocation must be
 * deterministic before an operator has ranked anything, or the same order
 * allocated twice could pick different warehouses.
 */
export async function listLocations(
  db: LocationReader,
  businessId: string,
  options: { readonly activeOnly?: boolean } = {},
): Promise<LocationSummary[]> {
  const conditions = [eq(locations.businessId, businessId), isNull(locations.deletedAt)];
  if (options.activeOnly === true) {
    conditions.push(eq(locations.isActive, true));
  }

  return db
    .select({
      id: locations.id,
      code: locations.code,
      name: locations.name,
      description: locations.description,
      timezone: locations.timezone,
      priority: locations.priority,
      isActive: locations.isActive,
    })
    .from(locations)
    .where(and(...conditions))
    .orderBy(asc(locations.priority), asc(locations.code));
}

export interface CreateLocationInput {
  readonly businessId: string;
  readonly code: string;
  readonly name: string;
  readonly description?: string | null;
  readonly timezone?: string;
  readonly priority?: number;
}

export type CreateLocationResult =
  | { readonly outcome: 'created'; readonly locationId: string }
  | { readonly outcome: 'code_taken' }
  | { readonly outcome: 'invalid'; readonly reason: string };

export async function createLocation(
  db: LocationWriter,
  input: CreateLocationInput,
): Promise<CreateLocationResult> {
  const code = input.code.trim();
  const name = input.name.trim();

  if (code.length === 0 || code.length > 64) {
    return { outcome: 'invalid', reason: 'a location code is between 1 and 64 characters' };
  }
  if (name.length === 0) {
    return { outcome: 'invalid', reason: 'a location needs a name' };
  }
  if (input.priority !== undefined && !isPriority(input.priority)) {
    return { outcome: 'invalid', reason: 'priority is a whole number between 0 and 10000' };
  }

  try {
    const [row] = await db
      .insert(locations)
      .values({
        businessId: input.businessId,
        code,
        name,
        description: input.description ?? null,
        ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
      })
      .returning({ id: locations.id });

    if (row === undefined) {
      throw new Error(`the location ${code} could not be created`);
    }

    return { outcome: 'created', locationId: row.id };
  } catch (error) {
    if (isUniqueViolation(error, 'locations_code_unique')) {
      return { outcome: 'code_taken' };
    }

    throw error;
  }
}

export interface UpdateLocationInput {
  readonly businessId: string;
  readonly locationId: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly timezone?: string;
  readonly priority?: number;
  readonly isActive?: boolean;
}

export type UpdateLocationResult =
  | { readonly outcome: 'updated' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Changes a location's description, ranking, or active state.
 *
 * The code is not changeable. It is what an operator writes on a shelf label and
 * what a CSV mapping import matches against, so renaming it silently would
 * repoint every reference that used it (section 7 makes the same argument about
 * SKUs never being identity).
 */
export async function updateLocation(
  db: LocationWriter,
  input: UpdateLocationInput,
): Promise<UpdateLocationResult> {
  if (input.priority !== undefined && !isPriority(input.priority)) {
    return { outcome: 'invalid', reason: 'priority is a whole number between 0 and 10000' };
  }
  const name = input.name?.trim();

  if (name?.length === 0) {
    return { outcome: 'invalid', reason: 'a location needs a name' };
  }

  const updated = await db
    .update(locations)
    .set({
      ...(name === undefined ? {} : { name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    })
    .where(
      and(
        eq(locations.businessId, input.businessId),
        eq(locations.id, input.locationId),
        isNull(locations.deletedAt),
      ),
    )
    .returning({ id: locations.id });

  return updated.length === 0 ? { outcome: 'not_found' } : { outcome: 'updated' };
}

export type ArchiveLocationResult =
  | { readonly outcome: 'archived' }
  | { readonly outcome: 'not_found' }
  /** Units are still here. Archiving would strand them (section 9). */
  | { readonly outcome: 'holds_stock'; readonly items: number };

/**
 * Soft-deletes a location that holds nothing.
 *
 * Section 17 soft-deletes catalog entities so history keeps a stable reference:
 * a ledger entry from last year names this location, and that entry must remain
 * explicable. Refusing while stock is present is the more interesting half.
 * Archiving a location holding units would leave those units counted in no pool
 * and reachable through no screen, which is a worse outcome than an error
 * message telling the operator to transfer them out first.
 */
export async function archiveLocation(
  db: LocationWriter,
  input: { readonly businessId: string; readonly locationId: string; readonly now?: Date },
): Promise<ArchiveLocationResult> {
  const held = await db
    .select({ canonicalItemId: locationBalances.canonicalItemId })
    .from(locationBalances)
    .where(
      and(
        eq(locationBalances.businessId, input.businessId),
        eq(locationBalances.locationId, input.locationId),
        or(gt(locationBalances.onHand, 0), gt(locationBalances.reserved, 0)),
      ),
    );

  if (held.length > 0) {
    return { outcome: 'holds_stock', items: held.length };
  }

  const archived = await db
    .update(locations)
    .set({ deletedAt: input.now ?? new Date(), isActive: false })
    .where(
      and(
        eq(locations.businessId, input.businessId),
        eq(locations.id, input.locationId),
        isNull(locations.deletedAt),
      ),
    )
    .returning({ id: locations.id });

  return archived.length === 0 ? { outcome: 'not_found' } : { outcome: 'archived' };
}

export interface PostalAddress {
  readonly name?: string | null;
  readonly company?: string | null;
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly region?: string | null;
  readonly postalCode?: string | null;
  /** ISO 3166-1 alpha-2. Normalized to upper case before storage. */
  readonly countryCode: string;
  readonly phone?: string | null;
  readonly email?: string | null;
}

export type SetAddressResult =
  | { readonly outcome: 'saved' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Records where parcels leave from, or where returns come back to.
 *
 * Optional for inventory and required before a label can be bought from this
 * location (section 9), so the shape is validated here rather than left for the
 * shipping provider to reject at the moment money is being spent.
 */
export async function setLocationAddress(
  db: LocationWriter,
  input: {
    readonly businessId: string;
    readonly locationId: string;
    readonly purpose: AddressPurpose;
    readonly address: PostalAddress;
  },
): Promise<SetAddressResult> {
  const countryCode = input.address.countryCode.trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { outcome: 'invalid', reason: 'country must be a two-letter ISO 3166-1 code' };
  }
  if (input.address.line1.trim().length === 0) {
    return { outcome: 'invalid', reason: 'an address needs a street line' };
  }
  if (input.address.city.trim().length === 0) {
    return { outcome: 'invalid', reason: 'an address needs a city' };
  }

  const [exists] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.businessId, input.businessId),
        eq(locations.id, input.locationId),
        isNull(locations.deletedAt),
      ),
    )
    .limit(1);

  if (exists === undefined) {
    return { outcome: 'not_found' };
  }

  const values = {
    name: input.address.name ?? null,
    company: input.address.company ?? null,
    line1: input.address.line1.trim(),
    line2: input.address.line2 ?? null,
    city: input.address.city.trim(),
    region: input.address.region ?? null,
    postalCode: input.address.postalCode ?? null,
    countryCode,
    phone: input.address.phone ?? null,
    email: input.address.email ?? null,
  };

  await db
    .insert(locationAddresses)
    .values({
      businessId: input.businessId,
      locationId: input.locationId,
      purpose: input.purpose,
      ...values,
    })
    .onConflictDoUpdate({
      target: [locationAddresses.locationId, locationAddresses.purpose],
      set: { ...values, updatedAt: sql`now()` },
    });

  return { outcome: 'saved' };
}

export async function readLocationAddress(
  db: LocationReader,
  input: {
    readonly businessId: string;
    readonly locationId: string;
    readonly purpose: AddressPurpose;
  },
): Promise<PostalAddress | null> {
  const [row] = await db
    .select({
      name: locationAddresses.name,
      company: locationAddresses.company,
      line1: locationAddresses.line1,
      line2: locationAddresses.line2,
      city: locationAddresses.city,
      region: locationAddresses.region,
      postalCode: locationAddresses.postalCode,
      countryCode: locationAddresses.countryCode,
      phone: locationAddresses.phone,
      email: locationAddresses.email,
    })
    .from(locationAddresses)
    .where(
      and(
        eq(locationAddresses.businessId, input.businessId),
        eq(locationAddresses.locationId, input.locationId),
        eq(locationAddresses.purpose, input.purpose),
      ),
    )
    .limit(1);

  return row ?? null;
}

export type LinkLocationResult =
  | { readonly outcome: 'linked' }
  /** Another internal location already answers to this provider identifier. */
  | { readonly outcome: 'external_id_taken' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Binds an internal location to the identifier a connection knows it by.
 *
 * Section 9 requires this to be explicit. Both uniqueness directions are
 * enforced in the database: one remote identifier names one shelf, and one shelf
 * has one identifier per connection. Either violation would send stock to the
 * wrong place while looking entirely reasonable in the UI.
 */
export async function linkLocationToChannel(
  db: LocationWriter,
  input: {
    readonly businessId: string;
    readonly locationId: string;
    readonly connectionId: string;
    readonly externalLocationId: string;
  },
): Promise<LinkLocationResult> {
  const externalLocationId = input.externalLocationId.trim();

  if (externalLocationId.length === 0 || externalLocationId.length > 128) {
    return { outcome: 'invalid', reason: 'a provider location identifier is 1 to 128 characters' };
  }

  try {
    await db
      .insert(locationChannelLinks)
      .values({
        businessId: input.businessId,
        locationId: input.locationId,
        connectionId: input.connectionId,
        externalLocationId,
      })
      .onConflictDoUpdate({
        target: [locationChannelLinks.connectionId, locationChannelLinks.locationId],
        set: { externalLocationId, updatedAt: sql`now()` },
      });

    return { outcome: 'linked' };
  } catch (error) {
    if (isUniqueViolation(error, 'location_channel_links_external_unique')) {
      return { outcome: 'external_id_taken' };
    }

    throw error;
  }
}

export async function unlinkLocationFromChannel(
  db: LocationWriter,
  input: {
    readonly businessId: string;
    readonly locationId: string;
    readonly connectionId: string;
  },
): Promise<{ readonly outcome: 'unlinked' | 'not_found' }> {
  const removed = await db
    .delete(locationChannelLinks)
    .where(
      and(
        eq(locationChannelLinks.businessId, input.businessId),
        eq(locationChannelLinks.locationId, input.locationId),
        eq(locationChannelLinks.connectionId, input.connectionId),
      ),
    )
    .returning({ id: locationChannelLinks.id });

  return { outcome: removed.length === 0 ? 'not_found' : 'unlinked' };
}

function isPriority(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}
