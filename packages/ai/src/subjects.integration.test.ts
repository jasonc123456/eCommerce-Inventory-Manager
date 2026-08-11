import { businesses, canonicalItems, connections, providerItems } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRequest } from './request';
import { SubjectNotFound, draftSubjectFor, kitSubjectFor, mappingSubjectFor } from './subjects';

/**
 * What is selected out of the shop's own records, and what is not.
 *
 * Section 18 requires the model to receive no credentials and no customer or
 * order detail; sections 7 and 10 require a person to decide every mapping and
 * every recipe. Both are properties of the queries in `subjects.ts`, so both are
 * tested against real rows that contain the things being excluded.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

interface Fixture {
  readonly businessId: string;
  readonly widgetId: string;
  readonly kitId: string;
  readonly providerItemId: string;
  readonly connectionId: string;
}

async function seed(): Promise<Fixture> {
  const { db } = harness;
  const slug = `subj-${String((counter += 1))}`;

  const [business] = await db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const businessId = business!.id;

  const [widget] = await db
    .insert(canonicalItems)
    .values({
      businessId,
      sku: `WID-${slug}`,
      name: 'Blue widget 40mm',
      description: 'A blue widget.',
    })
    .returning({ id: canonicalItems.id });

  await db
    .insert(canonicalItems)
    .values({ businessId, sku: `BRK-${slug}`, name: 'Bracket', description: null });

  const [kit] = await db
    .insert(canonicalItems)
    .values({ businessId, sku: `KIT-${slug}`, name: 'Starter kit', isKit: true })
    .returning({ id: canonicalItems.id });

  const [connection] = await db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'sandbox',
      externalAccountId: `seller-${slug}`,
      displayName: 'Seller',
      status: 'active',
    })
    .returning({ id: connections.id });

  const [entity] = await db
    .insert(providerItems)
    .values({
      businessId,
      connectionId: connection!.id,
      externalId: `ext-${slug}`,
      kind: 'listing',
      // Everything here that must not travel: a SKU, a price, and a quantity.
      sku: 'SECRET-SKU-9',
      title: 'BLUE WIDGET 40MM BNIB',
      quantity: 17,
      priceAmount: '12.9900',
      priceCurrency: 'GBP',
      inventoryEligible: true,
    })
    .returning({ id: providerItems.id });

  return {
    businessId,
    widgetId: widget!.id,
    kitId: kit!.id,
    providerItemId: entity!.id,
    connectionId: connection!.id,
  };
}

const options = { maxOutputTokens: 500, timeoutMs: 20_000, includeImages: false };

describe('a draft subject', () => {
  it('carries the catalogue name and description', async () => {
    const fixture = await seed();

    const subject = await draftSubjectFor(harness.db, {
      businessId: fixture.businessId,
      canonicalItemId: fixture.widgetId,
      destination: 'ebay',
    });

    expect(subject.title).toBe('Blue widget 40mm');
    expect(subject.description).toBe('A blue widget.');
  });

  it('refuses an item in another business', async () => {
    const one = await seed();
    const two = await seed();

    await expect(
      draftSubjectFor(harness.db, {
        businessId: two.businessId,
        canonicalItemId: one.widgetId,
        destination: 'ebay',
      }),
    ).rejects.toBeInstanceOf(SubjectNotFound);
  });
});

describe('a kit subject', () => {
  it('offers the components a business has, by name and nothing else', async () => {
    const fixture = await seed();

    const subject = await kitSubjectFor(harness.db, {
      businessId: fixture.businessId,
      kitCanonicalItemId: fixture.kitId,
    });

    expect(subject.title).toBe('Starter kit');
    expect(subject.availableComponents).toEqual(['Blue widget 40mm', 'Bracket']);
  });

  it('never offers a kit as a component of another kit', async () => {
    const fixture = await seed();

    const subject = await kitSubjectFor(harness.db, {
      businessId: fixture.businessId,
      kitCanonicalItemId: fixture.kitId,
    });

    expect(subject.availableComponents).not.toContain('Starter kit');
  });

  it('offers no other business’s catalogue', async () => {
    const one = await seed();
    await seed();

    const subject = await kitSubjectFor(harness.db, {
      businessId: one.businessId,
      kitCanonicalItemId: one.kitId,
    });

    expect(subject.availableComponents).toHaveLength(2);
  });
});

describe('a mapping subject', () => {
  it('carries the channel title and the shop item names', async () => {
    const fixture = await seed();

    const subject = await mappingSubjectFor(harness.db, {
      businessId: fixture.businessId,
      providerItemId: fixture.providerItemId,
    });

    expect(subject.channelEntityTitle).toBe('BLUE WIDGET 40MM BNIB');
    expect(subject.candidateItems).toContain('Blue widget 40mm');
  });

  it('carries no SKU, no price, and no quantity into the request that is sent', async () => {
    const fixture = await seed();

    const subject = await mappingSubjectFor(harness.db, {
      businessId: fixture.businessId,
      providerItemId: fixture.providerItemId,
    });
    const { request } = buildRequest(subject, options);
    const sent = `${request.instruction}\n${request.subject}`;

    expect(sent).not.toContain('SECRET-SKU-9');
    expect(sent).not.toContain('12.99');
    expect(sent).not.toContain('17');
  });

  it('says so plainly when the channel record has no title', async () => {
    const fixture = await seed();
    const [entity] = await harness.db
      .insert(providerItems)
      .values({
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalId: `untitled-${String((counter += 1))}`,
        kind: 'listing',
        inventoryEligible: true,
      })
      .returning({ id: providerItems.id });

    const subject = await mappingSubjectFor(harness.db, {
      businessId: fixture.businessId,
      providerItemId: entity!.id,
    });

    expect(subject.channelEntityTitle).toContain('no title');
  });
});
