import { describe, expect, it } from 'vitest';

import { isSuccess } from '../outcomes';
import { FakeShippingAdapter } from './fake-shipping-adapter';
import type { ShipmentAddress } from '../shipping';

/**
 * The fake is a test fixture, so what is worth asserting about it is the
 * behaviour the shipping suite will rely on being real: that quoting spends
 * nothing, that one idempotency key buys one label, and that a provider which
 * charges something other than what it quoted is reproducible.
 */

const from: ShipmentAddress = {
  name: 'DIY Geeks',
  line1: '1 Workshop Way',
  city: 'Leeds',
  postcode: 'LS1 1AA',
  country: 'GB',
};

const to: ShipmentAddress = {
  name: 'A Buyer',
  line1: '2 Buyer Street',
  city: 'Bristol',
  postcode: 'BS1 1AA',
  country: 'GB',
};

const request = { from, to, parcel: { weightGrams: 500 } };

describe('quoting', () => {
  it('prices a parcel without selling anything', async () => {
    const adapter = new FakeShippingAdapter();
    const quote = await adapter.quoteRates(request);

    expect(isSuccess(quote)).toBe(true);
    expect(adapter.purchases).toHaveLength(0);
    expect(adapter.sold.size).toBe(0);
  });

  it('carries a provider expiry only when the provider has one', async () => {
    const without = await new FakeShippingAdapter().quoteRates(request);
    const with_ = await new FakeShippingAdapter({ quoteLifetimeMs: 60_000 }).quoteRates(request);

    if (!isSuccess(without) || !isSuccess(with_)) {
      throw new Error('expected both quotes to succeed');
    }

    expect(without.value.rates[0]?.expiresAt).toBeUndefined();
    expect(with_.value.rates[0]?.expiresAt).toBeInstanceOf(Date);
    expect(with_.value.rates[0]?.expiresAt?.getTime()).toBe(
      with_.value.quotedAt.getTime() + 60_000,
    );
  });
});

describe('buying', () => {
  async function quoted(adapter: FakeShippingAdapter) {
    const quote = await adapter.quoteRates(request);
    if (!isSuccess(quote)) {
      throw new Error('expected a quote');
    }
    return quote.value;
  }

  it('buys one label per idempotency key, however many times it is asked', async () => {
    const adapter = new FakeShippingAdapter();
    const quote = await quoted(adapter);

    const buy = async () =>
      adapter.buyLabel({
        providerShipmentId: quote.providerShipmentId,
        rateId: 'rate-standard',
        confirmedAmount: '3.95',
        confirmedCurrency: 'GBP',
        idempotencyKey: 'key-1',
      });

    const first = await buy();
    const second = await buy();

    if (!isSuccess(first) || !isSuccess(second)) {
      throw new Error('expected both purchases to succeed');
    }

    expect(first.value.replayed).toBe(false);
    expect(second.value.replayed).toBe(true);
    expect(second.value.providerLabelId).toBe(first.value.providerLabelId);
    expect(adapter.sold.size).toBe(1);
  });

  it('can charge something other than what it quoted', async () => {
    const adapter = new FakeShippingAdapter({
      chargeInsteadOf: new Map([['rate-standard', '9.99']]),
    });
    const quote = await quoted(adapter);

    const bought = await adapter.buyLabel({
      providerShipmentId: quote.providerShipmentId,
      rateId: 'rate-standard',
      confirmedAmount: '3.95',
      confirmedCurrency: 'GBP',
      idempotencyKey: 'key-2',
    });

    if (!isSuccess(bought)) {
      throw new Error('expected the purchase to succeed');
    }

    // The fake reports the truth; refusing the mismatch is the caller's job,
    // and it cannot be tested without a provider that will do this.
    expect(bought.value.amount).toBe('9.99');
  });

  it('records an attempt that failed, so an ambiguous timeout is reproducible', async () => {
    const adapter = new FakeShippingAdapter({
      purchaseFailures: [{ status: 'unavailable', message: 'gateway timeout', statusCode: 504 }],
    });
    const quote = await quoted(adapter);

    const attempt = await adapter.buyLabel({
      providerShipmentId: quote.providerShipmentId,
      rateId: 'rate-standard',
      confirmedAmount: '3.95',
      confirmedCurrency: 'GBP',
      idempotencyKey: 'key-3',
    });

    expect(attempt.status).toBe('unavailable');
    expect(adapter.purchases).toHaveLength(1);
  });
});

describe('documents and voids', () => {
  async function bought(adapter: FakeShippingAdapter) {
    const quote = await adapter.quoteRates(request);
    if (!isSuccess(quote)) {
      throw new Error('expected a quote');
    }
    const label = await adapter.buyLabel({
      providerShipmentId: quote.value.providerShipmentId,
      rateId: 'rate-standard',
      confirmedAmount: '3.95',
      confirmedCurrency: 'GBP',
      idempotencyKey: 'key',
    });
    if (!isSuccess(label)) {
      throw new Error('expected a label');
    }
    return label.value;
  }

  it('names a document after the tracking number and not the buyer', async () => {
    const adapter = new FakeShippingAdapter();
    const label = await bought(adapter);

    const document = await adapter.fetchDocument({
      providerLabelId: label.providerLabelId,
      documentType: 'label',
    });

    if (!isSuccess(document)) {
      throw new Error('expected a document');
    }

    expect(document.value.filename).toContain(label.trackingNumber);
    expect(document.value.filename).not.toContain('Buyer');
  });

  it('refuses a document type the provider does not produce', async () => {
    const adapter = new FakeShippingAdapter();
    const label = await bought(adapter);

    const document = await adapter.fetchDocument({
      providerLabelId: label.providerLabelId,
      documentType: 'commercial_invoice',
    });

    expect(document.status).toBe('rejected');
  });

  it('treats a second void of the same label as the same answer', async () => {
    const adapter = new FakeShippingAdapter();
    const label = await bought(adapter);

    const first = await adapter.voidLabel({
      providerLabelId: label.providerLabelId,
      idempotencyKey: 'void-1',
    });
    const second = await adapter.voidLabel({
      providerLabelId: label.providerLabelId,
      idempotencyKey: 'void-1',
    });

    if (!isSuccess(first) || !isSuccess(second)) {
      throw new Error('expected both voids to succeed');
    }

    expect(first.value.outcome).toBe('refunded');
    expect(second.value.outcome).toBe('refunded');
  });

  it('reports a carrier that will not refund', async () => {
    const adapter = new FakeShippingAdapter({
      voidOutcome: { outcome: 'refused', detail: 'this service is not refundable' },
    });
    const label = await bought(adapter);

    const result = await adapter.voidLabel({
      providerLabelId: label.providerLabelId,
      idempotencyKey: 'void-2',
    });

    if (!isSuccess(result)) {
      throw new Error('expected the void call to succeed');
    }

    expect(result.value.outcome).toBe('refused');
    expect(result.value.refundAmount).toBeUndefined();
  });
});
