import type { AuditRecorder } from '@eim/audit';
import { shipmentPackages, shipmentRateQuotes, type Database } from '@eim/db';
import {
  describeFailure,
  isSuccess,
  type Parcel,
  type ShipmentAddress,
  type ShippingAdapter,
  type ShippingRate,
} from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import { PackageRefused, shipFromAddress } from './packages';
import { cheapestOf, earliestProviderExpiry, usableUntil } from './rate-selection';

/**
 * Asking what a parcel would cost (sections 2, 21, 30).
 *
 * Quoting spends nothing, so it can be done as often as anybody likes — and
 * that is the point of it being a separate call from buying. Section 21 asks for
 * "compare EasyPost/Easyship rates" as its own step, and section 30's US-13 for
 * "quote expiry/cost is shown"; both describe a screen somebody reads before
 * they decide, and a screen that bought something by being looked at would be a
 * different product.
 *
 * The quote is stored rather than recomputed. A screen that re-quoted on each
 * render would show a slightly different number each time, and the confirmation
 * would then apply to whichever quote happened to be current — which is exactly
 * what the reviewed-operation fingerprint exists to prevent.
 *
 * Two deadlines apply to a stored quote and the earlier of them wins. The
 * provider's own expiry is the real one: a carrier that has withdrawn a rate
 * will refuse to sell it whatever this application believes. The review window
 * is this application's own ceiling, and it exists for the providers that
 * publish no expiry at all — without it, a quote from this morning would still
 * be confirmable this afternoon.
 */

export interface QuoteRatesInput {
  readonly businessId: string;
  readonly packageId: string;
  readonly accountId: string;
  readonly adapter: ShippingAdapter;
  /**
   * Where the parcel is going, read from the channel at this moment.
   *
   * Passed in rather than stored, and read fresh rather than remembered. This
   * application deliberately keeps no copy of a buyer's postal address —
   * `channel_orders.buyer_reference` is a pseudonymous handle for exactly that
   * reason — so the address travels from the channel, through the quote, to the
   * carrier, and is kept only in the preview a person has to check before
   * confirming. Shipping to an address nobody looked at is the failure this
   * step exists to prevent, so it cannot be omitted from the review.
   */
  readonly to: ShipmentAddress;
  readonly actorUserId: string;
  readonly now?: Date;
}

export interface QuotedRates {
  readonly quoteId: string;
  readonly providerShipmentId: string;
  readonly rates: readonly ShippingRate[];
  readonly quotedAt: Date;
  /** The effective deadline: the earlier of the provider's and ours. */
  readonly usableUntil: Date;
}

export class RateQuoteFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateQuoteFailed';
  }
}

/**
 * Prices a package and records what came back.
 *
 * Only a package that has not been labelled may be quoted. A labelled package
 * already has a purchase behind it, and offering to price it again is offering
 * a second charge — buying a replacement is what voiding is for, and it starts
 * from a fresh quote once the old label is gone.
 */
export async function quoteRatesFor(
  db: Database,
  audit: AuditRecorder,
  input: QuoteRatesInput,
): Promise<QuotedRates> {
  const now = input.now ?? new Date();

  const parcels = await db
    .select()
    .from(shipmentPackages)
    .where(
      and(
        eq(shipmentPackages.id, input.packageId),
        eq(shipmentPackages.businessId, input.businessId),
      ),
    )
    .limit(1);

  const parcel = parcels[0];
  if (parcel === undefined) {
    throw new PackageRefused('unknown_order', 'no such package in this business');
  }

  if (parcel.status !== 'draft') {
    throw new PackageRefused(
      'package_not_open',
      `this package is ${parcel.status}; only a package without a label can be priced`,
    );
  }

  const from = await shipFromAddress(db, input.businessId, parcel.locationId);

  const quoted = await input.adapter.quoteRates({
    from,
    to: input.to,
    parcel: parcelOf(parcel),
    ...(parcel.declaredValueAmount === null
      ? {}
      : { declaredValueAmount: parcel.declaredValueAmount }),
    ...(parcel.declaredValueCurrency === null
      ? {}
      : { declaredValueCurrency: parcel.declaredValueCurrency }),
  });

  if (!isSuccess(quoted)) {
    throw new RateQuoteFailed(
      `the shipping provider could not price this: ${describeFailure(quoted)}`,
    );
  }

  const { providerShipmentId, rates, quotedAt } = quoted.value;

  if (rates.length === 0) {
    // A carrier with nothing to offer is a real answer, not a failure, and it
    // usually means the parcel is too heavy or the destination is not served.
    throw new RateQuoteFailed('no carrier offered a rate for this parcel');
  }

  const providerExpiresAt = earliestProviderExpiry(rates);

  const inserted = await db
    .insert(shipmentRateQuotes)
    .values({
      businessId: input.businessId,
      packageId: input.packageId,
      accountId: input.accountId,
      providerShipmentId,
      rates,
      quotedAt,
      requestedByUserId: input.actorUserId,
      createdAt: now,
      ...(providerExpiresAt === null ? {} : { providerExpiresAt }),
    })
    .returning({ id: shipmentRateQuotes.id });

  const row = inserted[0];
  if (row === undefined) {
    throw new RateQuoteFailed('the quote could not be recorded');
  }

  await audit.record(db, {
    action: 'shipping.rates.quoted',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipment_package',
    targetId: input.packageId,
    detail: {
      accountId: input.accountId,
      quoteId: row.id,
      rates: rates.length,
      cheapest: cheapestOf(rates)?.amount,
    },
  });

  return {
    quoteId: row.id,
    providerShipmentId,
    rates,
    quotedAt,
    usableUntil: usableUntil(quotedAt, providerExpiresAt),
  };
}

function parcelOf(parcel: {
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}): Parcel {
  return {
    weightGrams: parcel.weightGrams,
    ...(parcel.lengthMm === null ? {} : { lengthMm: parcel.lengthMm }),
    ...(parcel.widthMm === null ? {} : { widthMm: parcel.widthMm }),
    ...(parcel.heightMm === null ? {} : { heightMm: parcel.heightMm }),
  };
}
