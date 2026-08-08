import { describe, expect, it } from 'vitest';

import {
  assessDraftEligibility,
  mayConvert,
  type EbayDraftSource,
  type WooDraftSource,
} from './draft-eligibility';

/**
 * Section 6's decision table.
 *
 * The rows worth asserting are the refusals and, in particular, which kind of
 * refusal each one is. "Excluded" says the answer may change in a later version;
 * "ineligible" says it will not. A test that only checked that both were refused
 * would pass while the screen told somebody to wait for a release that will
 * never help them.
 */

const woo = (overrides: Partial<WooDraftSource> = {}): WooDraftSource => ({
  platform: 'woocommerce',
  productType: 'simple',
  managesStock: true,
  ...overrides,
});

const ebay = (overrides: Partial<EbayDraftSource> = {}): EbayDraftSource => ({
  platform: 'ebay',
  format: 'fixed_price',
  variationCount: 1,
  state: 'active',
  ...overrides,
});

describe('WooCommerce sources', () => {
  it('converts an ordinary simple product', () => {
    const verdict = assessDraftEligibility(woo());
    expect(verdict.verdict).toBe('eligible');
    expect(verdict.warnings).toHaveLength(0);
    expect(mayConvert(verdict)).toBe(true);
  });

  it('converts a product that is not managing stock, and says what that costs', () => {
    const verdict = assessDraftEligibility(woo({ managesStock: false }));
    expect(verdict.verdict).toBe('eligible');
    expect(verdict.warnings.join(' ')).toMatch(/not managing stock/);
  });

  it('warns that eBay cannot honour WooCommerce backorders', () => {
    // The two platforms disagree about what zero means, and the person
    // converting should learn that here rather than from a customer.
    const verdict = assessDraftEligibility(woo({ backordersEnabled: true }));
    expect(verdict.verdict).toBe('eligible');
    expect(verdict.warnings.join(' ')).toMatch(/clamp to zero/);
  });

  it('warns about a virtual product whose quantities depend on stock management', () => {
    const verdict = assessDraftEligibility(woo({ virtual: true }));
    expect(verdict.warnings.join(' ')).toMatch(/virtual or downloadable/);
  });

  it('excludes a variable product rather than calling it impossible', () => {
    const verdict = assessDraftEligibility(woo({ productType: 'variable' }));
    expect(verdict.verdict).toBe('excluded');
    expect(verdict.reason).toMatch(/version 1/);
  });

  it('calls a parent-level variable product ineligible, and says how to fix it', () => {
    // Not "not yet": there is no per-variation quantity to write at all, and the
    // remediation is a WooCommerce setting rather than a later release.
    const verdict = assessDraftEligibility(
      woo({ productType: 'variable', stockManagedAtParent: true }),
    );
    expect(verdict.verdict).toBe('ineligible');
    expect(verdict.reason).toMatch(/variation-level stock management/);
  });

  it('excludes a lone variation', () => {
    expect(assessDraftEligibility(woo({ productType: 'variation' })).verdict).toBe('excluded');
  });

  it('sends a grouped product back to its children', () => {
    const verdict = assessDraftEligibility(woo({ productType: 'grouped' }));
    expect(verdict.verdict).toBe('ineligible');
    expect(verdict.reason).toMatch(/child products/);
  });

  it('refuses the types section 6 does not interpret', () => {
    for (const productType of ['external', 'bundle', 'preorder'] as const) {
      expect(assessDraftEligibility(woo({ productType })).verdict).toBe('ineligible');
    }
  });
});

describe('eBay sources', () => {
  it('converts a single-SKU fixed-price listing', () => {
    expect(assessDraftEligibility(ebay()).verdict).toBe('eligible');
  });

  it('converts an out-of-stock listing, and says the draft carries fields not availability', () => {
    const verdict = assessDraftEligibility(ebay({ state: 'out_of_stock' }));
    expect(verdict.verdict).toBe('eligible');
    expect(verdict.warnings.join(' ')).toMatch(/not its availability/);
  });

  it('excludes auctions', () => {
    expect(assessDraftEligibility(ebay({ format: 'auction' })).verdict).toBe('excluded');
  });

  it('excludes multi-variation listings', () => {
    const verdict = assessDraftEligibility(ebay({ variationCount: 4 }));
    expect(verdict.verdict).toBe('excluded');
    expect(verdict.reason).toMatch(/every variation/);
  });

  it('tells an ended listing that it has ended, whatever else is true of it', () => {
    // Ending is the fact that changed and relisting is the workflow they need.
    // Reporting "auctions are excluded" would send them to the wrong screen.
    const verdict = assessDraftEligibility(ebay({ format: 'auction', state: 'ended' }));
    expect(verdict.verdict).toBe('ineligible');
    expect(verdict.reason).toMatch(/ended/);
  });
});

describe('kit sources', () => {
  it('converts, and says the recipe does not travel', () => {
    const verdict = assessDraftEligibility({ platform: 'kit' });
    expect(verdict.verdict).toBe('eligible');
    expect(verdict.warnings.join(' ')).toMatch(/recipe stays inside/);
  });
});

describe('mayConvert', () => {
  it('is true only for an eligible verdict', () => {
    expect(mayConvert(assessDraftEligibility(woo()))).toBe(true);
    expect(mayConvert(assessDraftEligibility(woo({ productType: 'variable' })))).toBe(false);
    expect(mayConvert(assessDraftEligibility(woo({ productType: 'grouped' })))).toBe(false);
  });
});
