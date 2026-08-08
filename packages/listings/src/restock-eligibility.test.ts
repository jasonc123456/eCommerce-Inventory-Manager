import { describe, expect, it } from 'vitest';

import { assessRestockEligibility, mayRestock, type RestockSubject } from './restock-eligibility';

/**
 * Section 6's restock rule, and the row above it.
 *
 * "Confirmed positive stock can return eligible listing to sale" sits directly
 * beneath "ended eBay listing … never automatically relisted", and the two
 * conditions look identical from outside: a listing a customer cannot buy from.
 * Everything here is about keeping them apart.
 */

const subject = (overrides: Partial<RestockSubject> = {}): RestockSubject => ({
  listingState: 'out_of_stock',
  outOfStockControlEnabled: true,
  availableToSell: 4,
  mappingStatus: 'active',
  ...overrides,
});

describe('assessRestockEligibility', () => {
  it('returns a hidden listing with stock behind it to sale', () => {
    const eligibility = assessRestockEligibility(subject());

    expect(eligibility.verdict).toBe('eligible');
    expect(eligibility.quantity).toBe(4);
    expect(mayRestock(eligibility)).toBe(true);
  });

  it('never relists an ended listing', () => {
    const eligibility = assessRestockEligibility(subject({ listingState: 'ended' }));

    expect(eligibility.verdict).toBe('listing_ended');
    expect(eligibility.reason).toMatch(/relisting is a separate decision/);
    expect(eligibility.quantity).toBeUndefined();
  });

  it('says the listing has ended even when everything else is also wrong', () => {
    // Telling somebody the mapping is paused when the listing is over has them
    // fix the mapping and try again for nothing.
    const eligibility = assessRestockEligibility(
      subject({ listingState: 'ended', mappingStatus: 'paused', availableToSell: 0 }),
    );

    expect(eligibility.verdict).toBe('listing_ended');
  });

  it('declines a listing that is already on sale', () => {
    const eligibility = assessRestockEligibility(subject({ listingState: 'active' }));

    expect(eligibility.verdict).toBe('already_live');
    expect(eligibility.reason).toMatch(/ordinary synchronization/);
  });

  it('explains that without out-of-stock control there is nothing to restore', () => {
    // Hitting zero ends an eBay listing rather than hiding it, so a seller who
    // never enabled the setting has nothing to return to sale.
    const eligibility = assessRestockEligibility(subject({ outOfStockControlEnabled: false }));

    expect(eligibility.verdict).toBe('out_of_stock_control_disabled');
  });

  it('refuses a mapping that is not active', () => {
    for (const mappingStatus of ['draft', 'approved', 'paused', 'archived'] as const) {
      expect(assessRestockEligibility(subject({ mappingStatus })).verdict).toBe(
        'mapping_not_active',
      );
    }
  });

  it('refuses to return a listing to sale with nothing behind it', () => {
    // It would be hidden again immediately, which is a confirmation that
    // achieved nothing and a listing that flickered.
    for (const availableToSell of [0, -3]) {
      expect(assessRestockEligibility(subject({ availableToSell })).verdict).toBe('no_stock');
    }
  });

  it('reports the pause before the shortage, because the pause is the blocker', () => {
    const eligibility = assessRestockEligibility(
      subject({ mappingStatus: 'paused', availableToSell: 0 }),
    );

    expect(eligibility.verdict).toBe('mapping_not_active');
  });
});

describe('mayRestock', () => {
  it('is true only for an eligible verdict', () => {
    expect(mayRestock(assessRestockEligibility(subject()))).toBe(true);
    expect(mayRestock(assessRestockEligibility(subject({ listingState: 'ended' })))).toBe(false);
    expect(mayRestock(assessRestockEligibility(subject({ availableToSell: 0 })))).toBe(false);
  });
});
