import type { ShipmentRateQuote } from '@eim/db';
import type { ShippingRate } from '@eim/providers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cheapestOf, earliestProviderExpiry, rateFrom, usableUntil } from './rate-selection';

/**
 * The rules that decide whether somebody may spend money on postage.
 *
 * Two of them are worth stating as properties rather than examples. The
 * effective deadline is never later than either of the deadlines it is derived
 * from — a bug there extends a quote past what the carrier will honour, and the
 * failure arrives as a refused purchase after somebody has confirmed. And the
 * cheapest rate is never more expensive than any other, which is the whole claim
 * the word makes.
 */

const OUR_WINDOW_MS = 10 * 60_000;
const at = (iso: string) => new Date(iso);

function rate(overrides: Partial<ShippingRate> = {}): ShippingRate {
  return {
    rateId: 'rate-1',
    carrier: 'RoyalMail',
    service: 'Tracked48',
    amount: '3.95',
    currency: 'GBP',
    ...overrides,
  };
}

describe('when a quote stops counting', () => {
  it('uses our own window when the provider publishes no deadline', () => {
    const quotedAt = at('2026-04-01T09:00:00.000Z');

    expect(usableUntil(quotedAt, null).getTime()).toBe(quotedAt.getTime() + OUR_WINDOW_MS);
  });

  it('defers to the provider when the provider is sooner', () => {
    const quotedAt = at('2026-04-01T09:00:00.000Z');
    const provider = at('2026-04-01T09:02:00.000Z');

    expect(usableUntil(quotedAt, provider)).toEqual(provider);
  });

  it('keeps our ceiling when the provider would hold a rate open for longer', () => {
    const quotedAt = at('2026-04-01T09:00:00.000Z');
    const provider = at('2026-04-01T18:00:00.000Z');

    // A rate a carrier will still honour this evening is not a rate somebody
    // should be able to confirm this evening against a parcel weighed this
    // morning.
    expect(usableUntil(quotedAt, provider).getTime()).toBe(quotedAt.getTime() + OUR_WINDOW_MS);
  });

  it('is never later than either deadline it was derived from', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.option(fc.integer({ min: 0, max: 2 ** 40 }), { nil: null }),
        (quotedAtMs, providerMs) => {
          const quotedAt = new Date(quotedAtMs);
          const provider = providerMs === null ? null : new Date(providerMs);
          const result = usableUntil(quotedAt, provider).getTime();

          expect(result).toBeLessThanOrEqual(quotedAtMs + OUR_WINDOW_MS);
          if (providerMs !== null) {
            expect(result).toBeLessThanOrEqual(providerMs);
          }
        },
      ),
    );
  });
});

describe('the provider deadline across several rates', () => {
  it('is the soonest of them', () => {
    const rates = [
      rate({ rateId: 'a', expiresAt: at('2026-04-01T10:00:00.000Z') }),
      rate({ rateId: 'b', expiresAt: at('2026-04-01T09:30:00.000Z') }),
      rate({ rateId: 'c', expiresAt: at('2026-04-01T11:00:00.000Z') }),
    ];

    expect(earliestProviderExpiry(rates)).toEqual(at('2026-04-01T09:30:00.000Z'));
  });

  it('is null when no rate carries one', () => {
    expect(earliestProviderExpiry([rate(), rate({ rateId: 'b' })])).toBeNull();
  });

  it('is not extended by a rate that says nothing', () => {
    const rates = [
      rate({ rateId: 'a', expiresAt: at('2026-04-01T09:30:00.000Z') }),
      rate({ rateId: 'b' }),
    ];

    expect(earliestProviderExpiry(rates)).toEqual(at('2026-04-01T09:30:00.000Z'));
  });

  it('is null for an empty list', () => {
    expect(earliestProviderExpiry([])).toBeNull();
  });
});

describe('the cheapest rate', () => {
  it('compares decimals without turning them into floats', () => {
    const rates = [
      rate({ rateId: 'a', amount: '10.00' }),
      rate({ rateId: 'b', amount: '9.99' }),
      rate({ rateId: 'c', amount: '10.1' }),
    ];

    expect(cheapestOf(rates)?.rateId).toBe('b');
  });

  it('handles differing decimal widths', () => {
    const rates = [rate({ rateId: 'a', amount: '3.9' }), rate({ rateId: 'b', amount: '3.85' })];

    expect(cheapestOf(rates)?.rateId).toBe('b');
  });

  it('handles whole amounts with no point at all', () => {
    const rates = [rate({ rateId: 'a', amount: '4' }), rate({ rateId: 'b', amount: '3.99' })];

    expect(cheapestOf(rates)?.rateId).toBe('b');
  });

  it('is null when there is nothing to choose from', () => {
    expect(cheapestOf([])).toBeNull();
  });

  it('is never more expensive than any other rate', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 99 })), {
          minLength: 1,
          maxLength: 12,
        }),
        (pairs) => {
          const rates = pairs.map(([whole, part], index) =>
            rate({
              rateId: `r${String(index)}`,
              amount: `${String(whole)}.${String(part).padStart(2, '0')}`,
            }),
          );

          const winner = cheapestOf(rates);
          const asPence = (amount: string) => Math.round(Number(amount) * 100);

          for (const candidate of rates) {
            expect(asPence(winner!.amount)).toBeLessThanOrEqual(asPence(candidate.amount));
          }
        },
      ),
    );
  });
});

describe('finding a rate in a stored quote', () => {
  const quote = { rates: [rate({ rateId: 'a' }), rate({ rateId: 'b' })] } as ShipmentRateQuote;

  it('returns the rate that was asked for', () => {
    expect(rateFrom(quote, 'b')?.rateId).toBe('b');
  });

  it('returns null rather than throwing for a rate that has gone', () => {
    // An ordinary thing for a screen to say when a page has been open across a
    // re-quote, not an exceptional condition.
    expect(rateFrom(quote, 'c')).toBeNull();
  });
});
