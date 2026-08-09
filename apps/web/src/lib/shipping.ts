import { authorize, type BusinessPermission } from '@eim/authz';
import {
  channelOrderLines,
  channelOrders,
  shipmentChannelPushes,
  shipmentLabels,
  shipmentPackageLines,
  shipmentPackages,
  shipmentTrackingEvents,
  shippingAccounts,
  type ShipmentChannelPush,
  type ShipmentLabel,
  type ShipmentPackage,
  type ShipmentTrackingEvent,
  type ShippingAccount,
} from '@eim/db';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { identity } from './identity';
import { runtime } from './runtime';

/**
 * Reading what is in the post, and what is still on the bench (sections 14, 21).
 *
 * Section 21 calls this screen "Orders and Shipping" and asks it to show
 * packages, rates, labels, tracking, and the "label-purchased-not-shipped
 * state" — which is the one worth naming, because it is the state a screen that
 * collapsed buying and shipping would be unable to display at all.
 *
 * Everything here is a read of this application's own records. Section 14 makes
 * them authoritative: "app-native package, label, carrier, and tracking records
 * are authoritative", so the screen shows what we know rather than asking a
 * carrier on every render.
 */

export interface PackageContent {
  readonly externalLineId: string;
  readonly title: string | null;
  readonly sku: string | null;
  readonly quantity: number;
}

export interface PackageView {
  readonly parcel: ShipmentPackage;
  readonly externalOrderId: string;
  readonly contents: readonly PackageContent[];
  /** The live label, if there is one. A voided label leaves none. */
  readonly label: ShipmentLabel | null;
  readonly tracking: readonly ShipmentTrackingEvent[];
  readonly pushes: readonly ShipmentChannelPush[];
  /** Whether this caller may mark it shipped, as `authorize` decides. */
  readonly mayMarkShipped: boolean;
  readonly mayVoid: boolean;
  readonly mayViewDocuments: boolean;
}

/**
 * Packages that still need something doing to them, newest first.
 *
 * Drafts and labelled parcels, which are the two states somebody acts on. A
 * shipped package is history and belongs on the order rather than on a work
 * list; a cancelled one is nothing at all.
 */
export async function loadOpenPackages(
  businessId: string,
  userId: string,
  limit = 50,
): Promise<PackageView[]> {
  const { db } = runtime();
  const subject = await identity().memberships.loadSubject(db, businessId, userId);

  if (subject === null) {
    return [];
  }

  const parcels = await db
    .select()
    .from(shipmentPackages)
    .where(
      and(
        eq(shipmentPackages.businessId, businessId),
        inArray(shipmentPackages.status, ['draft', 'labelled', 'shipped']),
      ),
    )
    .orderBy(desc(shipmentPackages.createdAt))
    .limit(limit);

  if (parcels.length === 0) {
    return [];
  }

  const packageIds = parcels.map((parcel) => parcel.id);
  const orderIds = [...new Set(parcels.map((parcel) => parcel.orderId))];

  const orders = await db
    .select({ id: channelOrders.id, externalOrderId: channelOrders.externalOrderId })
    .from(channelOrders)
    .where(and(eq(channelOrders.businessId, businessId), inArray(channelOrders.id, orderIds)));
  const orderById = new Map(orders.map((order) => [order.id, order.externalOrderId]));

  const contents = await db
    .select({
      packageId: shipmentPackageLines.packageId,
      quantity: shipmentPackageLines.quantity,
      externalLineId: channelOrderLines.externalLineId,
      title: channelOrderLines.title,
      sku: channelOrderLines.sku,
    })
    .from(shipmentPackageLines)
    .innerJoin(
      channelOrderLines,
      and(
        eq(channelOrderLines.id, shipmentPackageLines.orderLineId),
        eq(channelOrderLines.businessId, shipmentPackageLines.businessId),
      ),
    )
    .where(
      and(
        eq(shipmentPackageLines.businessId, businessId),
        inArray(shipmentPackageLines.packageId, packageIds),
      ),
    );

  const labels = await db
    .select()
    .from(shipmentLabels)
    .where(
      and(
        eq(shipmentLabels.businessId, businessId),
        inArray(shipmentLabels.packageId, packageIds),
        // A voided label is gone as far as this screen is concerned: the package
        // is back to needing one. The history is still in the table.
        inArray(shipmentLabels.state, ['purchased', 'void_requested', 'void_refused']),
      ),
    );
  const labelByPackage = new Map(labels.map((label) => [label.packageId, label]));

  const events =
    labels.length === 0
      ? []
      : await db
          .select()
          .from(shipmentTrackingEvents)
          .where(
            and(
              eq(shipmentTrackingEvents.businessId, businessId),
              inArray(
                shipmentTrackingEvents.labelId,
                labels.map((label) => label.id),
              ),
            ),
          )
          .orderBy(desc(shipmentTrackingEvents.occurredAt));

  const pushes = await db
    .select()
    .from(shipmentChannelPushes)
    .where(
      and(
        eq(shipmentChannelPushes.businessId, businessId),
        inArray(shipmentChannelPushes.packageId, packageIds),
      ),
    );

  // Asked once per permission rather than once per package. The answer cannot
  // differ between two packages in the same business, and asking per row would
  // suggest it could.
  const may = (permission: BusinessPermission) => authorize(subject, permission).allowed;
  const mayMarkShipped = may('mark_shipped');
  const mayVoid = may('void_labels');
  const mayViewDocuments = may('view_shipments');

  return parcels.map((parcel) => {
    const label = labelByPackage.get(parcel.id) ?? null;

    return {
      parcel,
      externalOrderId: orderById.get(parcel.orderId) ?? parcel.orderId,
      contents: contents
        .filter((line) => line.packageId === parcel.id)
        .map(({ externalLineId, title, sku, quantity }) => ({
          externalLineId,
          title,
          sku,
          quantity,
        })),
      label,
      tracking: label === null ? [] : events.filter((event) => event.labelId === label.id),
      pushes: pushes.filter((push) => push.packageId === parcel.id),
      mayMarkShipped,
      mayVoid,
      mayViewDocuments,
    };
  });
}

/** The business's shipping accounts, so the screen can say whether it has one. */
export async function loadShippingAccounts(businessId: string): Promise<ShippingAccount[]> {
  const { db } = runtime();

  return db
    .select()
    .from(shippingAccounts)
    .where(eq(shippingAccounts.businessId, businessId))
    .orderBy(shippingAccounts.provider);
}
