import { describe, expect, it } from 'vitest';

import { applySelections, draftIsComplete, projectDraft, type DraftSubject } from './draft-fields';

/**
 * What survives a conversion, and what a person is told does not (section 30,
 * US-11).
 *
 * The assertions that matter are about the absences. That a title carries across
 * is not in doubt; that a reviewer is told the condition must be chosen, that
 * the bundled warranty metadata will be dropped, and that no path through this
 * module can produce a published product is what US-11 actually asks for.
 */

const subject = (overrides: Partial<DraftSubject> = {}): DraftSubject => ({
  title: 'Brass garden hose fitting',
  description: 'A fitting, made of brass.',
  sku: 'HOSE-BRASS-1',
  price: { amount: '12.50', currency: 'GBP' },
  quantity: 7,
  imageUrls: ['https://example.invalid/hose.jpg'],
  categoryHints: ['Garden', 'Watering'],
  unmodelledFields: [],
  ...overrides,
});

describe('projecting to eBay', () => {
  it('carries the fields a product record can supply', () => {
    const projection = projectDraft({ subject: subject(), destination: 'ebay' });

    expect(projection.fields).toMatchObject({
      title: 'Brass garden hose fitting',
      sku: 'HOSE-BRASS-1',
      price: '12.50',
      currency: 'GBP',
      quantity: 7,
    });
  });

  it('asks for a condition rather than assuming one', () => {
    // WooCommerce has no condition field. Guessing "new" on a reseller's
    // catalogue would be a policy violation this application wrote.
    const projection = projectDraft({ subject: subject(), destination: 'ebay' });

    expect(projection.missing).toContain('condition');
    expect(projection.warnings.join(' ')).toMatch(/does not record a condition/);
  });

  it('reports a missing SKU as the source’s problem, not the reviewer’s', () => {
    const { sku: _sku, ...noSku } = subject();
    const projection = projectDraft({ subject: noSku, destination: 'ebay' });

    expect(projection.missing).toContain('sku');
    expect(projection.requiresSelection).not.toContain('sku');
  });

  it('treats an empty string as absent', () => {
    const projection = projectDraft({ subject: subject({ sku: '' }), destination: 'ebay' });
    expect(projection.missing).toContain('sku');
  });

  it('demands the choices only a person can make', () => {
    const projection = projectDraft({ subject: subject(), destination: 'ebay' });

    // Section 13's publication requirements that a product record cannot imply.
    expect(projection.requiresSelection).toEqual(
      expect.arrayContaining([
        'category',
        'itemAspects',
        'marketplace',
        'listingDuration',
        'inventoryLocation',
        'paymentPolicy',
        'returnPolicy',
        'fulfillmentPolicy',
      ]),
    );
  });

  it('offers the source categories as hints and applies none of them', () => {
    // A category picked by string-matching a shop's own names is how a garden
    // hose ends up under Medical Supplies.
    const projection = projectDraft({ subject: subject(), destination: 'ebay' });

    expect(projection.fields['category']).toBeUndefined();
    expect(projection.warnings.join(' ')).toMatch(/shown as hints/);
  });

  it('names every source field it could not model', () => {
    const projection = projectDraft({
      subject: subject({ unmodelledFields: ['_warranty_length', '_bundle_children'] }),
      destination: 'ebay',
    });

    expect(projection.unsupported).toEqual(['_warranty_length', '_bundle_children']);
  });

  it('says the quantity stops being the source’s once the mapping is live', () => {
    const projection = projectDraft({ subject: subject(), destination: 'ebay' });
    expect(projection.warnings.join(' ')).toMatch(/this application owns it/);
  });

  it('reports every absence at once rather than one per attempt', () => {
    // A screen that reveals the next missing field only after the last one has
    // been fixed makes a five-minute job into five trips.
    const bare = {
      title: 'Untitled',
      imageUrls: [],
      categoryHints: [],
      unmodelledFields: [],
    };
    const projection = projectDraft({ subject: bare, destination: 'ebay' });

    expect(projection.missing).toEqual(
      expect.arrayContaining(['description', 'sku', 'price', 'images', 'condition']),
    );
  });

  it('carries a condition the source does have', () => {
    const projection = projectDraft({
      subject: subject({ condition: 'refurbished' }),
      destination: 'ebay',
    });

    expect(projection.fields['condition']).toBe('refurbished');
    expect(projection.missing).not.toContain('condition');
  });

  it('carries shipping dimensions to eBay too', () => {
    const projection = projectDraft({
      subject: subject({ weightGrams: 250, lengthMm: 80, widthMm: 40, heightMm: 40 }),
      destination: 'ebay',
    });

    expect(projection.fields).toMatchObject({
      weightGrams: 250,
      lengthMm: 80,
      widthMm: 40,
      heightMm: 40,
    });
  });

  it('says nothing about categories when the source suggests none', () => {
    const projection = projectDraft({
      subject: subject({ categoryHints: [] }),
      destination: 'ebay',
    });

    expect(projection.warnings.join(' ')).not.toMatch(/hints/);
  });
});

describe('projecting to WooCommerce', () => {
  it('always produces a simple product in draft status', () => {
    // Section 30's US-11: publication must be impossible from the draft action.
    // A projection that could carry `publish` would be one edit away from it.
    const projection = projectDraft({ subject: subject(), destination: 'woocommerce' });

    expect(projection.fields['type']).toBe('simple');
    expect(projection.fields['status']).toBe('draft');
  });

  it('never produces a publishable status, whatever the source looked like', () => {
    const { description: _description, ...bare } = subject({ quantity: 0, imageUrls: [] });

    for (const candidate of [subject(), subject({ quantity: 0 }), bare]) {
      const projection = projectDraft({ subject: candidate, destination: 'woocommerce' });
      expect(projection.fields['status']).toBe('draft');
    }
  });

  it('drops a condition rather than writing it into somebody’s copy', () => {
    const projection = projectDraft({
      subject: subject({ condition: 'used' }),
      destination: 'woocommerce',
    });

    expect(projection.unsupported).toContain('condition');
    expect(projection.fields['condition']).toBeUndefined();
  });

  it('warns that WooCommerce will not convert the currency', () => {
    const projection = projectDraft({ subject: subject(), destination: 'woocommerce' });
    expect(projection.warnings.join(' ')).toMatch(/will not convert/);
  });

  it('accepts a product with no description, and says so', () => {
    // WooCommerce will publish without one; it is still worth saying.
    const { description: _description, ...noDescription } = subject();
    const projection = projectDraft({ subject: noDescription, destination: 'woocommerce' });

    expect(projection.missing).not.toContain('description');
    expect(projection.warnings.join(' ')).toMatch(/no description/);
  });

  it('reports an empty description the same as an absent one', () => {
    const projection = projectDraft({
      subject: subject({ description: '' }),
      destination: 'woocommerce',
    });

    expect(projection.warnings.join(' ')).toMatch(/no description/);
  });

  it('says when a source has no images to carry', () => {
    const projection = projectDraft({
      subject: subject({ imageUrls: [] }),
      destination: 'woocommerce',
    });

    expect(projection.warnings.join(' ')).toMatch(/no images/);
  });

  it('omits a price the source does not have, rather than inventing one', () => {
    const { price: _price, ...noPrice } = subject();
    const projection = projectDraft({ subject: noPrice, destination: 'woocommerce' });

    expect(projection.missing).toContain('regularPrice');
    expect(projection.fields['regularPrice']).toBeUndefined();
  });

  it('leaves the stock quantity out when the source has none', () => {
    const { quantity: _quantity, ...noQuantity } = subject();
    const projection = projectDraft({ subject: noQuantity, destination: 'woocommerce' });

    expect(projection.fields['stockQuantity']).toBeUndefined();
  });

  it('says nothing about categories when the source suggests none', () => {
    const projection = projectDraft({
      subject: subject({ categoryHints: [] }),
      destination: 'woocommerce',
    });

    expect(projection.warnings.join(' ')).not.toMatch(/hints/);
  });

  it('carries shipping dimensions when the source has them', () => {
    const projection = projectDraft({
      subject: subject({ weightGrams: 250, lengthMm: 80, widthMm: 40, heightMm: 40 }),
      destination: 'woocommerce',
    });

    expect(projection.fields).toMatchObject({
      weightGrams: 250,
      lengthMm: 80,
      widthMm: 40,
      heightMm: 40,
    });
  });
});

describe('draftIsComplete', () => {
  it('is false while anything is missing or unchosen', () => {
    expect(draftIsComplete(projectDraft({ subject: subject(), destination: 'ebay' }))).toBe(false);
  });

  it('is true only once both lists are empty', () => {
    const projection = projectDraft({
      subject: subject({ condition: 'new' }),
      destination: 'woocommerce',
    });

    const chosen = applySelections(projection, {
      categories: ['Garden'],
      taxStatus: 'taxable',
      catalogVisibility: 'visible',
    });

    expect(draftIsComplete(chosen)).toBe(true);
  });
});

describe('applySelections', () => {
  it('leaves a selection outstanding when it was not answered', () => {
    const projection = projectDraft({ subject: subject(), destination: 'woocommerce' });
    const partial = applySelections(projection, { categories: ['Garden'] });

    expect(partial.requiresSelection).toEqual(['taxStatus', 'catalogVisibility']);
    expect(draftIsComplete(partial)).toBe(false);
  });

  it('ignores answers to questions the projection never asked', () => {
    // A caller that could add arbitrary keys could satisfy completeness with
    // fields eBay never asked about while the category was still unset.
    const projection = projectDraft({ subject: subject(), destination: 'woocommerce' });
    const applied = applySelections(projection, {
      categories: ['Garden'],
      taxStatus: 'taxable',
      catalogVisibility: 'visible',
      status: 'publish',
    });

    expect(applied.fields['status']).toBe('draft');
  });
});
