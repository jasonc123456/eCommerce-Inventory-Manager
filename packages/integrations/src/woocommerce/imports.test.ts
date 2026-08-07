import { describe, expect, it } from 'vitest';

import {
  backordersEnabled,
  mapOrder,
  mapProduct,
  mapRefund,
  mapVariation,
  productIneligibility,
} from './imports';

/**
 * Turning what a store said into what this application records.
 *
 * The assertions worth having here are about eligibility and about money. An
 * eligibility mistake is silent — a product looks mappable, gets mapped, and the
 * writes go into a field the store ignores. A money mistake is worse: a price
 * that has been through a float is a price that is no longer the one the store
 * quoted, and nothing downstream can tell.
 */

const SIMPLE = {
  id: 42,
  name: 'Blue widget',
  sku: 'BW-1',
  type: 'simple',
  status: 'publish',
  manage_stock: true,
  stock_quantity: 7,
  backorders: 'no',
  price: '19.99',
};

describe('mapProduct', () => {
  it('reads a simple product that manages its own stock', () => {
    expect(mapProduct(SIMPLE, 'GBP')).toMatchObject({
      externalId: '42',
      kind: 'product',
      sku: 'BW-1',
      title: 'Blue widget',
      quantity: 7,
      priceAmount: '19.99',
      providerStatus: 'publish',
      inventoryEligible: true,
      ineligibleReason: null,
    });
  });

  it('keeps a price as the store wrote it', () => {
    // 19.99 through a double is 19.989999999999998. Prices are decimals and
    // stay text from the store to the column.
    expect(mapProduct({ ...SIMPLE, price: '0.10' }, 'GBP')?.priceAmount).toBe('0.10');
    expect(mapProduct({ ...SIMPLE, price: '1234567.8901' }, 'GBP')?.priceAmount).toBe(
      '1234567.8901',
    );
  });

  it('refuses a price that is not one', () => {
    for (const price of ['', 'free', 'NaN', '1.2.3', '£5', null, {}]) {
      expect(mapProduct({ ...SIMPLE, price }, 'GBP')?.priceAmount).toBeNull();
    }
  });

  it('drops a price it cannot name a currency for', () => {
    // The database refuses an amount with no currency, and it is right to: a
    // bare number compared against an eBay price is a comparison between an
    // amount and an amount of nothing in particular.
    const mapped = mapProduct(SIMPLE, null);

    expect(mapped?.priceAmount).toBeNull();
    expect(mapped?.priceCurrency).toBeNull();
  });

  it('names the store currency on a price it keeps', () => {
    expect(mapProduct(SIMPLE, 'GBP')).toMatchObject({
      priceAmount: '19.99',
      priceCurrency: 'GBP',
    });
  });

  it('reports no quantity for a product that does not manage stock', () => {
    // WooCommerce keeps a stale `stock_quantity` on such products. Reading it
    // would synchronize a number nothing in the store consults.
    const mapped = mapProduct({ ...SIMPLE, manage_stock: false, stock_quantity: 99 });

    expect(mapped?.quantity).toBeNull();
    expect(mapped?.inventoryEligible).toBe(false);
  });

  it('reads a quantity the store sent as a string', () => {
    expect(mapProduct({ ...SIMPLE, stock_quantity: '12' })?.quantity).toBe(12);
    expect(mapProduct({ ...SIMPLE, stock_quantity: '-3' })?.quantity).toBe(-3);
    expect(mapProduct({ ...SIMPLE, stock_quantity: 'lots' })?.quantity).toBeNull();
  });

  it('drops a product with no identifier', () => {
    expect(mapProduct({ ...SIMPLE, id: 0 })).toBeNull();
    expect(mapProduct({ ...SIMPLE, id: null })).toBeNull();
    expect(mapProduct('not a product')).toBeNull();
  });
});

describe('productIneligibility', () => {
  it('accepts a simple product that manages stock', () => {
    expect(productIneligibility('simple', true)).toBeNull();
  });

  it('accepts a variable product that leaves stock to its variations', () => {
    expect(productIneligibility('variable', false)).toBeNull();
  });

  it('refuses a variable product that manages stock at the parent', () => {
    // The case section 6 exists for. One quantity covers every variation, so a
    // variation mapped to a listing has no number to read or write — and writes
    // to it go into a field the store ignores while the parent goes on governing
    // what can actually be sold.
    expect(productIneligibility('variable', true)).toEqual(
      expect.stringContaining('manages stock at the parent'),
    );
  });

  it('names the product type it does not support rather than guessing', () => {
    for (const type of ['subscription', 'bundle', 'composite', 'unknown']) {
      expect(productIneligibility(type, true)).toEqual(expect.stringContaining(type));
    }
  });
});

describe('mapVariation', () => {
  const parent = mapProduct({ ...SIMPLE, id: 10, type: 'variable', manage_stock: false })!;

  it('reads a variation that manages its own stock', () => {
    expect(
      mapVariation(
        { id: 11, sku: 'BW-S', manage_stock: true, stock_quantity: 4, price: '9.50' },
        parent,
        'GBP',
      ),
    ).toMatchObject({
      externalId: '11',
      parentExternalId: '10',
      kind: 'variation',
      quantity: 4,
      inventoryEligible: true,
    });
  });

  it('makes a variation ineligible when it does not manage its own stock', () => {
    const mapped = mapVariation({ id: 12, manage_stock: false }, parent);

    expect(mapped?.inventoryEligible).toBe(false);
    expect(mapped?.ineligibleReason).toEqual(
      expect.stringContaining('does not manage its own stock'),
    );
  });

  it('inherits the parent’s ineligibility', () => {
    // A parent holding one quantity for the whole product leaves its variations
    // with nothing of their own, whatever their own flag says.
    const blocked = mapProduct({ ...SIMPLE, id: 20, type: 'variable', manage_stock: true })!;
    const mapped = mapVariation({ id: 21, manage_stock: true, stock_quantity: 3 }, blocked);

    expect(mapped?.inventoryEligible).toBe(false);
    expect(mapped?.ineligibleReason).toBe(blocked.ineligibleReason);
  });
});

describe('backordersEnabled', () => {
  it('treats notify as enabled', () => {
    // `notify` allows the sale and emails the shopkeeper. Reading it as "no"
    // would clamp a store that deliberately sells on backorder.
    expect(backordersEnabled('yes')).toBe(true);
    expect(backordersEnabled('notify')).toBe(true);
    expect(backordersEnabled(true)).toBe(true);
  });

  it('treats anything else as disabled', () => {
    for (const value of ['no', '', null, undefined, 0, 'maybe']) {
      expect(backordersEnabled(value)).toBe(false);
    }
  });
});

describe('mapOrder', () => {
  const ORDER = {
    id: 501,
    number: '501',
    status: 'processing',
    currency: 'GBP',
    total: '39.98',
    customer_id: 7,
    date_created_gmt: '2026-03-01T10:00:00',
    date_modified_gmt: '2026-03-02T11:30:00',
    line_items: [
      { id: 1, product_id: 42, variation_id: 0, sku: 'BW-1', quantity: 2, price: 19.99 },
    ],
  };

  it('reads an order and its lines', () => {
    expect(mapOrder(ORDER)).toMatchObject({
      externalId: '501',
      externalReference: '501',
      providerStatus: 'processing',
      totalAmount: '39.98',
      totalCurrency: 'GBP',
      buyerExternalId: '7',
    });

    expect(mapOrder(ORDER)?.lines[0]).toMatchObject({
      externalId: '1',
      itemExternalId: '42',
      variationExternalId: null,
      quantity: 2,
      quantityFulfilled: 0,
    });
  });

  it('reads a GMT timestamp as UTC rather than as the container’s timezone', () => {
    // WooCommerce's `_gmt` fields carry no zone marker. Parsed without one,
    // JavaScript reads them in local time and moves every order by the host's
    // offset — and the host is a container whose timezone nobody chose.
    expect(mapOrder(ORDER)?.placedAt?.toISOString()).toBe('2026-03-01T10:00:00.000Z');
  });

  it('records a guest checkout as having no customer', () => {
    // WooCommerce uses customer 0 for a guest. Storing "0" would make every
    // guest order in the store look like one person's.
    expect(mapOrder({ ...ORDER, customer_id: 0 })?.buyerExternalId).toBeNull();
  });

  it('keeps no buyer name, email, or address', () => {
    const mapped = mapOrder({
      ...ORDER,
      billing: { first_name: 'Ada', email: 'ada@example.invalid', address_1: '1 Test Road' },
    });

    const fields = Object.keys(mapped ?? {});

    expect(fields).not.toContain('email');
    expect(fields).not.toContain('billing');
    expect(mapped?.buyerExternalId).toBe('7');
  });

  it('drops a line with no quantity, and an order with no identifier', () => {
    expect(mapOrder({ ...ORDER, line_items: [{ id: 1, quantity: 0 }] })?.lines).toEqual([]);
    expect(mapOrder({ ...ORDER, id: null })).toBeNull();
  });
});

describe('mapRefund', () => {
  it('reads a refund as a financial event', () => {
    expect(
      mapRefund(
        {
          id: 900,
          amount: '19.99',
          reason: 'damaged in transit',
          date_created_gmt: '2026-03-05T09:00:00',
        },
        '501',
      ),
    ).toMatchObject({
      externalId: '900',
      orderExternalId: '501',
      amount: '19.99',
      reason: 'damaged in transit',
    });
  });

  it('keeps the amount as the store sent it, sign and all', () => {
    expect(mapRefund({ id: 901, amount: '-5.00' }, '501')?.amount).toBe('-5.00');
  });

  it('drops a refund with no identifier', () => {
    expect(mapRefund({ amount: '1.00' }, '501')).toBeNull();
  });
});
