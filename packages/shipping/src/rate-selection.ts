import type { ShipmentRateQuote } from '@eim/db';
import type { ShippingRate } from '@eim/providers';
import { reviewWindowFor } from '@eim/review';

/**
 * Choosing between quoted rates, and knowing when they stop counting
 * (sections 21, 30).
 *
 * Pure, and deliberately separate from the module that talks to a provider.
 * Every rule here decides whether somebody may spend money, and a rule that can
 * only be exercised by waiting ten minutes with a real carrier is a rule nobody
 * exercises. Nothing in this file reads a clock, a database, or a network.
 */

/**
 * When a quote stops being worth confirming.
 *
 * The earlier of the provider's own deadline and the review window for a label
 * purchase. Pure, and separate from everything that touches a database, because
 * this is the rule a confirmation turns on and a rule that can only be tested by
 * waiting is a rule nobody tests.
 */
export function usableUntil(quotedAt: Date, providerExpiresAt: Date | null): Date {
  const ours = new Date(quotedAt.getTime() + reviewWindowFor('label_purchase').sourceMaxAgeMs);

  if (providerExpiresAt === null) {
    return ours;
  }

  return providerExpiresAt.getTime() < ours.getTime() ? providerExpiresAt : ours;
}

/**
 * The soonest any of these rates stops being honoured.
 *
 * The soonest rather than the one attached to a chosen rate, because the stored
 * deadline governs the whole quote and a screen showing four rates should not
 * offer one that has quietly outlived three others. A rate with no expiry does
 * not extend the quote: it simply says nothing.
 */
export function earliestProviderExpiry(rates: readonly ShippingRate[]): Date | null {
  let earliest: Date | null = null;

  for (const rate of rates) {
    if (rate.expiresAt === undefined) {
      continue;
    }
    if (earliest === null || rate.expiresAt.getTime() < earliest.getTime()) {
      earliest = rate.expiresAt;
    }
  }

  return earliest;
}

/** The cheapest rate, for a summary line. Never chosen automatically. */
export function cheapestOf(rates: readonly ShippingRate[]): ShippingRate | null {
  let cheapest: ShippingRate | null = null;

  for (const rate of rates) {
    if (cheapest === null || compareAmount(rate.amount, cheapest.amount) < 0) {
      cheapest = rate;
    }
  }

  return cheapest;
}

/**
 * Finds a rate in a stored quote.
 *
 * Returns null rather than throwing, because "the rate you chose is not in this
 * quote" is an ordinary thing for a screen to say when somebody has had a page
 * open across a re-quote.
 */
export function rateFrom(quote: ShipmentRateQuote, rateId: string): ShippingRate | null {
  const rates = quote.rates as readonly ShippingRate[];

  return rates.find((rate) => rate.rateId === rateId) ?? null;
}

/**
 * Compares two decimal amounts without turning either into a number.
 *
 * The same reasoning as `@eim/listings`' money module: a postage cost that has
 * been through a float is not the postage cost. Only ordering is needed here,
 * so this is deliberately smaller than that module rather than a copy of it.
 */
function compareAmount(left: string, right: string): number {
  const [leftWhole = '0', leftPart = ''] = left.split('.');
  const [rightWhole = '0', rightPart = ''] = right.split('.');

  const whole = Number(leftWhole) - Number(rightWhole);
  if (whole !== 0) {
    return whole;
  }

  const width = Math.max(leftPart.length, rightPart.length);

  return Number(leftPart.padEnd(width, '0')) - Number(rightPart.padEnd(width, '0'));
}
