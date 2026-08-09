import type { AuditRecorder } from '@eim/audit';
import {
  channelOrderLines,
  channelOrders,
  locationAddresses,
  locations,
  shipmentPackageLines,
  shipmentPackages,
  type Database,
  type ShipmentPackage,
} from '@eim/db';
import type { ShipmentAddress } from '@eim/providers';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Building a parcel out of an order (sections 9, 11, 14).
 *
 * Partial shipments are ordinary. Section 14 says so outright — "the application
 * supports partial shipments" — and section 13 says the same of eBay: "support
 * partial quantities and multiple packages". So a package holds quantities of
 * order lines rather than whole lines, an order has as many packages as it
 * needs, and the only rule that binds them together is that the packages of one
 * line never claim more than the line has left to ship.
 *
 * That rule is enforced here rather than by a constraint, because it is a sum
 * across rows and the check must happen under a lock. Two people packing the
 * same order at the same moment is not a hypothetical — it is a Monday morning
 * in a shop with two benches — and without the lock both would read "two left"
 * and both would put two in a box.
 *
 * The other rule is section 9's, and it is why a package names a location: "a
 * full address is optional for inventory but required for label purchase from
 * that location". The address is read from the location when it is needed rather
 * than copied here, so correcting a wrong address corrects the next label
 * instead of leaving a stale copy behind on every package already built.
 */

export interface PackageLineInput {
  readonly orderLineId: string;
  readonly quantity: number;
}

export interface CreatePackageInput {
  readonly businessId: string;
  readonly orderId: string;
  readonly locationId: string;
  readonly lines: readonly PackageLineInput[];
  readonly weightGrams: number;
  readonly lengthMm?: number;
  readonly widthMm?: number;
  readonly heightMm?: number;
  readonly declaredValueAmount?: string;
  readonly declaredValueCurrency?: string;
  readonly reference?: string;
  readonly notes?: string;
  readonly actorUserId: string;
  readonly now?: Date;
}

export class PackageRefused extends Error {
  readonly reason: PackageRefusalReason;

  constructor(reason: PackageRefusalReason, message: string) {
    super(message);
    this.name = 'PackageRefused';
    this.reason = reason;
  }
}

export type PackageRefusalReason =
  | 'no_lines'
  | 'unknown_order'
  | 'unknown_line'
  | 'quantity_not_available'
  | 'location_unusable'
  | 'package_not_open';

/** How much of one order line is still waiting to go in a box. */
export interface LineAvailability {
  readonly orderLineId: string;
  readonly ordered: number;
  readonly cancelled: number;
  readonly refunded: number;
  /** Already committed to packages that have not been cancelled. */
  readonly packed: number;
  /** What may still be packed. Never negative. */
  readonly remaining: number;
}

/**
 * What is left to ship on each line of an order.
 *
 * Cancelled and refunded quantities are subtracted because neither is going
 * anywhere, and a screen offering to put a refunded item in a box is offering to
 * ship goods the customer has already been paid back for. What is *not*
 * subtracted is `shippedQuantity` from the channel: that number is the
 * provider's opinion, arrived at from fulfilments the provider knows about, and
 * this application's own packages are the authority for what it has sent —
 * section 14 is explicit that "app-native package, label, carrier, and tracking
 * records are authoritative".
 */
export async function availabilityFor(
  db: Database,
  businessId: string,
  orderId: string,
): Promise<LineAvailability[]> {
  const lines = await db
    .select()
    .from(channelOrderLines)
    .where(
      and(eq(channelOrderLines.businessId, businessId), eq(channelOrderLines.orderId, orderId)),
    );

  if (lines.length === 0) {
    return [];
  }

  const packed = await packedQuantities(
    db,
    businessId,
    lines.map((line) => line.id),
  );

  return lines.map((line) => {
    const alreadyPacked = packed.get(line.id) ?? 0;
    const shippable = line.quantity - line.cancelledQuantity - line.refundedQuantity;

    return {
      orderLineId: line.id,
      ordered: line.quantity,
      cancelled: line.cancelledQuantity,
      refunded: line.refundedQuantity,
      packed: alreadyPacked,
      remaining: Math.max(0, shippable - alreadyPacked),
    };
  });
}

/**
 * Creates a package, or refuses and explains why.
 *
 * Everything happens in one transaction with the order lines locked, so the
 * availability the decision was made from is the availability that still holds
 * when the rows are written.
 */
export async function createPackage(
  db: Database,
  audit: AuditRecorder,
  input: CreatePackageInput,
): Promise<ShipmentPackage> {
  const now = input.now ?? new Date();

  if (input.lines.length === 0) {
    throw new PackageRefused('no_lines', 'a package has to contain something');
  }

  for (const line of input.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new PackageRefused(
        'quantity_not_available',
        'a package line has to hold a whole positive quantity',
      );
    }
  }

  const created = await db.transaction(async (tx) => {
    const orders = await tx
      .select()
      .from(channelOrders)
      .where(
        and(eq(channelOrders.id, input.orderId), eq(channelOrders.businessId, input.businessId)),
      )
      .limit(1);

    if (orders[0] === undefined) {
      throw new PackageRefused('unknown_order', 'no such order in this business');
    }

    // Locked for the rest of the transaction. This is the whole reason the rule
    // lives here: the sum below and the insert beneath it have to see the same
    // world, and two benches packing one order is an ordinary morning.
    const requested = input.lines.map((line) => line.orderLineId);
    const lines = await tx
      .select()
      .from(channelOrderLines)
      .where(
        and(
          eq(channelOrderLines.businessId, input.businessId),
          eq(channelOrderLines.orderId, input.orderId),
          inArray(channelOrderLines.id, requested),
        ),
      )
      .for('update');

    if (lines.length !== requested.length) {
      throw new PackageRefused('unknown_line', 'a requested line is not on that order');
    }

    const packed = await packedQuantities(tx, input.businessId, requested);

    for (const line of lines) {
      const asked =
        input.lines.find((candidate) => candidate.orderLineId === line.id)?.quantity ?? 0;
      const shippable = line.quantity - line.cancelledQuantity - line.refundedQuantity;
      const remaining = Math.max(0, shippable - (packed.get(line.id) ?? 0));

      if (asked > remaining) {
        throw new PackageRefused(
          'quantity_not_available',
          `line ${line.externalLineId} has ${String(remaining)} left to ship, not ${String(asked)}`,
        );
      }
    }

    await assertLocationUsable(tx, input.businessId, input.locationId);

    const inserted = await tx
      .insert(shipmentPackages)
      .values({
        businessId: input.businessId,
        orderId: input.orderId,
        locationId: input.locationId,
        weightGrams: input.weightGrams,
        createdByUserId: input.actorUserId,
        createdAt: now,
        updatedAt: now,
        ...(input.lengthMm === undefined ? {} : { lengthMm: input.lengthMm }),
        ...(input.widthMm === undefined ? {} : { widthMm: input.widthMm }),
        ...(input.heightMm === undefined ? {} : { heightMm: input.heightMm }),
        ...(input.declaredValueAmount === undefined
          ? {}
          : { declaredValueAmount: input.declaredValueAmount }),
        ...(input.declaredValueCurrency === undefined
          ? {}
          : { declaredValueCurrency: input.declaredValueCurrency }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      })
      .returning();

    const parcel = inserted[0];
    if (parcel === undefined) {
      throw new PackageRefused('unknown_order', 'the package could not be created');
    }

    await tx.insert(shipmentPackageLines).values(
      input.lines.map((line) => ({
        businessId: input.businessId,
        packageId: parcel.id,
        orderLineId: line.orderLineId,
        quantity: line.quantity,
        createdAt: now,
      })),
    );

    return parcel;
  });

  await audit.record(db, {
    action: 'shipping.package.created',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipment_package',
    targetId: created.id,
    detail: {
      orderId: input.orderId,
      locationId: input.locationId,
      weightGrams: input.weightGrams,
      lines: input.lines.length,
    },
  });

  return created;
}

/**
 * Withdraws a package that has not been labelled.
 *
 * Only from `draft`. A labelled package holds a purchase that has already cost
 * money, and making it disappear would leave the label paid for and unattached
 * to anything — voiding the label is what that situation calls for, and it is a
 * different action with a different permission.
 */
export async function cancelPackage(
  db: Database,
  audit: AuditRecorder,
  input: { readonly businessId: string; readonly packageId: string; readonly now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();

  const cancelled = await db
    .update(shipmentPackages)
    .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
    .where(
      and(
        eq(shipmentPackages.id, input.packageId),
        eq(shipmentPackages.businessId, input.businessId),
        eq(shipmentPackages.status, 'draft'),
      ),
    )
    .returning({ id: shipmentPackages.id });

  if (cancelled[0] === undefined) {
    throw new PackageRefused(
      'package_not_open',
      'only a package that has not been labelled can be cancelled',
    );
  }

  await audit.record(db, {
    action: 'shipping.package.cancelled',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipment_package',
    targetId: input.packageId,
  });
}

/**
 * The ship-from address, or a refusal naming what is missing.
 *
 * Section 9's rule, applied at the moment it matters. A location with no address
 * is perfectly valid for holding stock, so this is not a validation error on the
 * location — it is a reason this particular location cannot buy postage today,
 * and the message says which field is absent so somebody can go and fix it.
 */
export async function shipFromAddress(
  db: Database,
  businessId: string,
  locationId: string,
): Promise<ShipmentAddress> {
  const rows = await db
    .select()
    .from(locationAddresses)
    .where(
      and(
        eq(locationAddresses.businessId, businessId),
        eq(locationAddresses.locationId, locationId),
        eq(locationAddresses.purpose, 'ship_from'),
      ),
    )
    .limit(1);

  const address = rows[0];
  if (address === undefined) {
    throw new PackageRefused(
      'location_unusable',
      'this location has no ship-from address, which a carrier requires',
    );
  }

  // `postal_code` is nullable on the table because inventory does not need one,
  // and a carrier does. Named individually rather than as "incomplete address",
  // because the person reading this has to go and find the missing field.
  const missing: string[] = [];
  if (address.name === null || address.name.trim() === '') {
    missing.push('name');
  }
  if (address.postalCode === null || address.postalCode.trim() === '') {
    missing.push('postal code');
  }

  if (missing.length > 0) {
    throw new PackageRefused(
      'location_unusable',
      `the ship-from address for this location is missing its ${missing.join(' and ')}`,
    );
  }

  return {
    name: address.name ?? '',
    line1: address.line1,
    city: address.city,
    postcode: address.postalCode ?? '',
    country: address.countryCode,
    ...(address.company === null ? {} : { company: address.company }),
    ...(address.line2 === null ? {} : { line2: address.line2 }),
    ...(address.region === null ? {} : { region: address.region }),
    ...(address.phone === null ? {} : { phone: address.phone }),
    ...(address.email === null ? {} : { email: address.email }),
  };
}

/** How much of each line is already committed to packages that still count. */
async function packedQuantities(
  db: Pick<Database, 'select'>,
  businessId: string,
  orderLineIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderLineIds.length === 0) {
    return new Map();
  }

  // Cancelled packages release what they held. Everything else — draft,
  // labelled, shipped — still counts, because a draft package is somebody's
  // half-packed box and its contents are spoken for.
  const rows = await db
    .select({
      orderLineId: shipmentPackageLines.orderLineId,
      total: sql<number>`sum(${shipmentPackageLines.quantity})::int`,
    })
    .from(shipmentPackageLines)
    .innerJoin(
      shipmentPackages,
      and(
        eq(shipmentPackages.id, shipmentPackageLines.packageId),
        eq(shipmentPackages.businessId, shipmentPackageLines.businessId),
      ),
    )
    .where(
      and(
        eq(shipmentPackageLines.businessId, businessId),
        inArray(shipmentPackageLines.orderLineId, [...orderLineIds]),
        sql`${shipmentPackages.status} <> 'cancelled'`,
      ),
    )
    .groupBy(shipmentPackageLines.orderLineId);

  return new Map(rows.map((row) => [row.orderLineId, row.total]));
}

async function assertLocationUsable(
  db: Pick<Database, 'select'>,
  businessId: string,
  locationId: string,
): Promise<void> {
  const rows = await db
    .select({ isActive: locations.isActive })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.businessId, businessId)))
    .limit(1);

  const location = rows[0];
  if (location === undefined) {
    throw new PackageRefused('location_unusable', 'no such location in this business');
  }

  if (!location.isActive) {
    throw new PackageRefused('location_unusable', 'that location is not active');
  }
}
