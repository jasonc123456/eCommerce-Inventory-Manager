import { describe, expect, it } from 'vitest';

import { mapInventoryItem, mapLocation, mapOffer, mapOrder, mapPolicy } from './imports';

/**
 * Reading what eBay sent.
 *
 * The cases below are the ones where a charitable reading is worse than a
 * refusal: a record with no identifier that later cannot be addressed, a
 * quantity that arrived as a string, a fulfilment count larger than the order it
 * belongs to. Each of those parses fine and is wrong.
 */

describe('mapInventoryItem', () => {
  it('reads an item, addressed by its SKU', () => {
    const item = mapInventoryItem({
      sku: 'WIDGET-1',
      product: { title: 'A widget' },
      availability: { shipToLocationAvailability: { quantity: 12 } },
    });

    expect(item).toMatchObject({
      externalId: 'WIDGET-1',
      sku: 'WIDGET-1',
      kind: 'inventory_item',
      title: 'A widget',
      quantity: 12,
      inventoryEligible: true,
    });
  });

  it('drops an item with no SKU, because nothing could address it later', () => {
    for (const entry of [{}, { sku: '' }, { sku: '   ' }, { sku: 42 }, null, 'text', []]) {
      expect(mapInventoryItem(entry)).toBeNull();
    }
  });

  it('records an absent quantity as absent rather than as zero', () => {
    // Zero means "none in stock" and drives a listing to hide. Unknown means we
    // did not learn, and must not.
    const item = mapInventoryItem({ sku: 'WIDGET-2' });

    expect(item?.quantity).toBeNull();
  });

  it('keeps the whole payload for fields nothing here models', () => {
    const item = mapInventoryItem({ sku: 'W', packageWeightAndSize: { weight: { value: 2 } } });

    expect(item?.raw).toMatchObject({ packageWeightAndSize: { weight: { value: 2 } } });
  });
});

describe('mapOffer', () => {
  it('reads a published offer as eligible', () => {
    const offer = mapOffer(
      {
        offerId: 'offer-1',
        availableQuantity: 5,
        listing: { listingId: '110000000001' },
        pricingSummary: { price: { value: '19.99', currency: 'USD' } },
        status: 'PUBLISHED',
      },
      'WIDGET-1',
    );

    expect(offer).toMatchObject({
      externalId: 'offer-1',
      parentExternalId: 'WIDGET-1',
      kind: 'offer',
      quantity: 5,
      priceAmount: '19.99',
      priceCurrency: 'USD',
      inventoryEligible: true,
      ineligibleReason: null,
    });
  });

  it('imports an unpublished offer and marks it ineligible with a reason', () => {
    // A seller's draft is part of their catalog. Hiding it would make the
    // import look wrong to anybody comparing it against Seller Hub, and
    // pretending it can carry stock would be worse.
    const offer = mapOffer({ offerId: 'offer-2', availableQuantity: 0 }, 'WIDGET-1');

    expect(offer?.inventoryEligible).toBe(false);
    expect(offer?.ineligibleReason).toContain('published');
    expect(offer?.providerStatus).toBe('UNPUBLISHED');
  });

  it('drops an offer with no identifier', () => {
    expect(mapOffer({ availableQuantity: 1 }, 'W')).toBeNull();
  });
});

describe('mapLocation', () => {
  it('reads a location and its enabled state', () => {
    expect(
      mapLocation({
        merchantLocationKey: 'WAREHOUSE',
        name: 'Main',
        merchantLocationStatus: 'ENABLED',
      }),
    ).toMatchObject({ externalId: 'WAREHOUSE', name: 'Main', enabled: true });
  });

  it('reads a disabled location as disabled rather than dropping it', () => {
    // It still exists on the account, and an operator looking for it needs to
    // be told why it cannot be mapped.
    expect(
      mapLocation({ merchantLocationKey: 'OLD', merchantLocationStatus: 'DISABLED' })?.enabled,
    ).toBe(false);
  });

  it('treats an unstated status as enabled, which is what eBay means by it', () => {
    expect(mapLocation({ merchantLocationKey: 'W' })?.enabled).toBe(true);
  });
});

describe('mapPolicy', () => {
  it('reads a policy of each family', () => {
    expect(
      mapPolicy(
        { paymentPolicyId: '1', name: 'Standard', marketplaceId: 'EBAY_US' },
        'payment',
        'paymentPolicyId',
      ),
    ).toMatchObject({ externalId: '1', policyType: 'payment', name: 'Standard' });
  });

  it('drops a policy with no identifier', () => {
    expect(mapPolicy({ name: 'Nameless' }, 'return', 'returnPolicyId')).toBeNull();
  });
});

describe('mapOrder', () => {
  const order = {
    orderId: '12-34567-89012',
    legacyOrderId: '123456789012',
    creationDate: '2026-03-01T10:00:00.000Z',
    lastModifiedDate: '2026-03-02T10:00:00.000Z',
    orderFulfillmentStatus: 'NOT_STARTED',
    pricingSummary: { total: { value: '39.98', currency: 'USD' } },
    buyer: { username: 'a-buyer' },
    lineItems: [
      {
        lineItemId: 'line-1',
        legacyItemId: '110000000001',
        sku: 'WIDGET-1',
        quantity: 2,
        quantityShipped: 1,
        lineItemCost: { value: '19.99', currency: 'USD' },
      },
    ],
  };

  it('reads an order and its lines', () => {
    const mapped = mapOrder(order);

    expect(mapped).toMatchObject({
      externalId: '12-34567-89012',
      externalReference: '123456789012',
      providerStatus: 'NOT_STARTED',
      totalAmount: '39.98',
      totalCurrency: 'USD',
    });

    expect(mapped?.placedAt).toEqual(new Date('2026-03-01T10:00:00.000Z'));
    expect(mapped?.lines[0]).toMatchObject({
      externalId: 'line-1',
      sku: 'WIDGET-1',
      quantity: 2,
      quantityFulfilled: 1,
    });
  });

  it('keeps only the buyer identifier, not the buyer', () => {
    // Section 13 makes deletion compliance mandatory because buyer data is
    // stored. The cheapest way to comply is to store almost none of it.
    const mapped = mapOrder({
      ...order,
      buyer: {
        username: 'a-buyer',
        buyerRegistrationAddress: {
          fullName: 'A Person',
          email: 'person@example.invalid',
          contactAddress: { addressLine1: '1 Test Street' },
        },
      },
    });

    expect(mapped?.buyerExternalId).toBe('a-buyer');
    // The raw payload is retained under the raw-event retention window, but the
    // column an application query would reach for holds nothing identifying.
    expect(Object.keys(mapped ?? {})).not.toContain('buyerName');
    expect(Object.keys(mapped ?? {})).not.toContain('buyerEmail');
  });

  it('clamps a fulfilment count larger than the line it belongs to', () => {
    // eBay has been known to report a fulfilment against a cancelled line, and
    // the database refuses more shipped than sold.
    const mapped = mapOrder({
      ...order,
      lineItems: [{ lineItemId: 'l', quantity: 1, quantityShipped: 3 }],
    });

    expect(mapped?.lines[0]?.quantityFulfilled).toBe(1);
  });

  it('drops a line with no quantity rather than assuming one', () => {
    const mapped = mapOrder({
      ...order,
      lineItems: [
        { lineItemId: 'good', quantity: 1 },
        { lineItemId: 'no-quantity' },
        { lineItemId: 'zero', quantity: 0 },
        { quantity: 5 },
      ],
    });

    expect(mapped?.lines.map((line) => line.externalId)).toEqual(['good']);
  });

  it('drops an order with no identifier', () => {
    expect(mapOrder({ legacyOrderId: '1' })).toBeNull();
  });

  it('reads an unparseable date as absent rather than as the epoch', () => {
    // The epoch would classify every such order as pre-activation, which is a
    // decision about whether it consumes stock.
    const mapped = mapOrder({ ...order, creationDate: 'not a date' });

    expect(mapped?.placedAt).toBeNull();
  });
});
