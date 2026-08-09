import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import { businesses, reviewedOperations, users } from '@eim/db';
import { FakeChannelAdapter, type FakeAdapterOptions } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { confirmOperation } from '@eim/review';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DraftRefused,
  executeDraftCreation,
  executePublication,
  proposeDraft,
  proposePublication,
} from './drafts';
import type { DraftSubject } from './draft-fields';

/**
 * Two stages, two confirmations (sections 13, 14, 30).
 *
 * The assertions worth writing are the ones about what cannot happen: that
 * creating a draft does not publish it, that publishing needs a second
 * confirmation from a second read, that the fees somebody saw are the fees they
 * agreed to, and that a re-quote invalidates the agreement rather than being
 * applied over it.
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
  readonly userId: string;
  readonly owner: Subject;
  readonly audit: AuditRecorder;
}

async function seed(): Promise<Fixture> {
  const slug = `draft-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Cataloguer' })
    .returning({ id: users.id });

  const userId = user!.id;
  const businessId = business!.id;

  return {
    businessId,
    userId,
    owner: { userId, isOwner: true, grants: [] },
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
  };
}

const base = new Date('2026-03-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);
const MINUTE = 60_000;

const subject: DraftSubject = {
  title: 'Brass garden hose fitting',
  description: 'A fitting, made of brass.',
  sku: 'HOSE-BRASS-1',
  price: { amount: '12.50', currency: 'GBP' },
  quantity: 7,
  imageUrls: ['https://example.invalid/hose.jpg'],
  categoryHints: ['Garden'],
  unmodelledFields: ['_warranty_length'],
};

function adapter(options: FakeAdapterOptions = {}): FakeChannelAdapter {
  return new FakeChannelAdapter({ listingOperations: true, ...options });
}

async function confirm(
  fixture: Fixture,
  operationId: string,
  fingerprint: string,
  now = at(MINUTE),
) {
  const outcome = await confirmOperation(harness.db, {
    businessId: fixture.businessId,
    operationId,
    subject: fixture.owner,
    fingerprint,
    hasRecentAuthentication: true,
    now,
  });
  if (!outcome.confirmed) {
    throw new Error(`expected a confirmation, got ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome;
}

/** Proposes, confirms, and creates a draft — the ordinary first stage. */
async function createDraft(fixture: Fixture, channel = adapter()) {
  const proposal = await proposeDraft(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    destination: 'woocommerce',
    destinationConnectionId: crypto.randomUUID(),
    source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
    subject,
    selections: { categories: ['Garden'], taxStatus: 'taxable', catalogVisibility: 'visible' },
    sourceObservedAt: base,
    actorUserId: fixture.userId,
    subjectKey: `listing:${String((counter += 1))}`,
    now: base,
  });

  await confirm(fixture, proposal.operationId, proposal.fingerprint);
  const created = await executeDraftCreation(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    operationId: proposal.operationId,
    adapter: channel,
  });

  return { proposal, created, channel };
}

describe('proposeDraft', () => {
  it('refuses a type section 6 excludes, before anything reaches a provider', async () => {
    const fixture = await seed();

    await expect(
      proposeDraft(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        destination: 'woocommerce',
        destinationConnectionId: crypto.randomUUID(),
        source: { platform: 'ebay', format: 'auction', variationCount: 1, state: 'active' },
        subject,
        sourceObservedAt: base,
        actorUserId: fixture.userId,
        subjectKey: 'listing:auction',
        now: base,
      }),
    ).rejects.toBeInstanceOf(DraftRefused);
  });

  it('proposes an incomplete draft rather than demanding it be finished first', async () => {
    // A draft with an unchosen category is exactly what somebody sits down to
    // finish. Refusing until every field is filled would mean the review had to
    // happen before the thing being reviewed existed.
    const fixture = await seed();

    const proposal = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'ebay',
      destinationConnectionId: crypto.randomUUID(),
      source: { platform: 'woocommerce', productType: 'simple', managesStock: true },
      subject,
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'product:incomplete',
      now: base,
    });

    expect(proposal.requiresSelection).toContain('category');
    expect(proposal.missing).toContain('condition');
  });

  it('carries the dropped fields into what was agreed to', async () => {
    // A reviewer who agreed to a conversion dropping one field has not agreed to
    // one dropping five, so the unsupported list is inside the fingerprint.
    const fixture = await seed();

    const first = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'woocommerce',
      destinationConnectionId: crypto.randomUUID(),
      source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
      subject,
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'listing:fingerprint-a',
      now: base,
    });

    const second = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'woocommerce',
      destinationConnectionId: crypto.randomUUID(),
      source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
      subject: { ...subject, unmodelledFields: ['_warranty_length', '_bundle_children'] },
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'listing:fingerprint-b',
      now: base,
    });

    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('records that it was proposed', async () => {
    const fixture = await seed();
    await createDraft(fixture);

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId, { limit: 50 });
    expect(events.map((event) => event.action)).toContain('review.operation.proposed');
  });
});

describe('executeDraftCreation', () => {
  it('creates the draft that was confirmed, and nothing else', async () => {
    const fixture = await seed();
    const { created, channel } = await createDraft(fixture);

    expect(created.externalDraftId).toBe('DRAFT-1');
    expect(channel.drafts).toHaveLength(1);
    // The whole point of the stage: nothing is live.
    expect(channel.published).toHaveLength(0);
    expect(channel.drafts[0]?.published).toBe(false);
  });

  it('sends the fields from the operation, not from the caller', async () => {
    const fixture = await seed();
    const { channel } = await createDraft(fixture);

    expect(channel.drafts[0]?.fields).toMatchObject({
      name: 'Brass garden hose fitting',
      sku: 'HOSE-BRASS-1',
      status: 'draft',
      type: 'simple',
    });
  });

  it('will not run without a confirmation', async () => {
    const fixture = await seed();
    const proposal = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'woocommerce',
      destinationConnectionId: crypto.randomUUID(),
      source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
      subject,
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'listing:unconfirmed',
      now: base,
    });

    const channel = adapter();
    await expect(
      executeDraftCreation(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toBeInstanceOf(DraftRefused);
    expect(channel.calls).toHaveLength(0);
  });

  it('records the provider’s refusal against the operation', async () => {
    const fixture = await seed();
    const channel = adapter();
    channel.failNext({ status: 'rejected', message: 'the SKU is already in use' });

    const proposal = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'woocommerce',
      destinationConnectionId: crypto.randomUUID(),
      source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
      subject,
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'listing:rejected',
      now: base,
    });
    await confirm(fixture, proposal.operationId, proposal.fingerprint);

    await expect(
      executeDraftCreation(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: channel,
      }),
    ).rejects.toBeInstanceOf(DraftRefused);

    const [row] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));
    expect(row?.state).toBe('failed');
    expect(row?.failureSummary).toMatch(/rejected/);
  });

  it('refuses a channel that has no listing operations at all', async () => {
    const fixture = await seed();
    const proposal = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'woocommerce',
      destinationConnectionId: crypto.randomUUID(),
      source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
      subject,
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'listing:incapable',
      now: base,
    });
    await confirm(fixture, proposal.operationId, proposal.fingerprint);

    await expect(
      executeDraftCreation(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter: new FakeChannelAdapter(),
      }),
    ).rejects.toThrow(/cannot create drafts/);
  });
});

describe('proposePublication', () => {
  it('quotes the fees at the moment of proposing, not when the draft was made', async () => {
    const fixture = await seed();
    const { proposal, channel } = await createDraft(fixture);

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: proposal.operationId,
      adapter: channel,
      actorUserId: fixture.userId,
      now: at(30 * MINUTE),
    });

    expect(channel.calls).toContain('previewPublication');
    expect(publication.totalAmount).toBe('1.55');
    // Quoted at proposal time, so the fifteen-minute window runs from here.
    expect(publication.expiresAt).toEqual(at(60 * MINUTE));
  });

  it('demands a second confirmation with the publication permission', async () => {
    const fixture = await seed();
    const { proposal, channel } = await createDraft(fixture);

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: proposal.operationId,
      adapter: channel,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });

    const [row] = await harness.db
      .select()
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, publication.operationId));

    expect(row?.kind).toBe('draft_publish');
    expect(row?.requiredPermission).toBe('publish_products');
    // Publication is a step-up action, whatever the draft creation was.
    expect(row?.requiresRecentAuthentication).toBe(true);
    expect(row?.parentOperationId).toBe(proposal.operationId);
  });

  it('demands publish_listings when the destination is eBay', async () => {
    const fixture = await seed();
    const channel = adapter();

    const proposal = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'ebay',
      destinationConnectionId: crypto.randomUUID(),
      source: { platform: 'woocommerce', productType: 'simple', managesStock: true },
      subject: { ...subject, condition: 'new' },
      selections: {
        category: '12345',
        itemAspects: ['Brand: Unbranded'],
        marketplace: 'EBAY_GB',
        listingDuration: 'GTC',
        inventoryLocation: 'MAIN',
        paymentPolicy: 'PAY-1',
        returnPolicy: 'RET-1',
        fulfillmentPolicy: 'FUL-1',
      },
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'product:to-ebay',
      now: base,
    });
    await confirm(fixture, proposal.operationId, proposal.fingerprint);
    await executeDraftCreation(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter: channel,
    });

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: proposal.operationId,
      adapter: channel,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });

    const [row] = await harness.db
      .select({ permission: reviewedOperations.requiredPermission })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, publication.operationId));
    expect(row?.permission).toBe('publish_listings');
  });

  it('refuses to propose what the provider says it would reject', async () => {
    // A confirmation button above a list of reasons the provider will refuse
    // invites somebody to press it and learn nothing.
    const fixture = await seed();
    const channel = adapter({ publicationBlockers: ['a category is required'] });
    const { proposal } = await createDraft(fixture, channel);

    await expect(
      proposePublication(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        draftOperationId: proposal.operationId,
        adapter: channel,
        actorUserId: fixture.userId,
        now: at(2 * MINUTE),
      }),
    ).rejects.toThrow(/would refuse this publication/);
  });

  it('will not publish a draft that was never created', async () => {
    const fixture = await seed();
    const channel = adapter();

    const proposal = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'woocommerce',
      destinationConnectionId: crypto.randomUUID(),
      source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
      subject,
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'listing:never-created',
      now: base,
    });

    await expect(
      proposePublication(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        draftOperationId: proposal.operationId,
        adapter: channel,
        actorUserId: fixture.userId,
        now: at(2 * MINUTE),
      }),
    ).rejects.toThrow(/no created draft/);
  });

  it('refuses a confirmation once the fees have been re-quoted', async () => {
    // The fee is part of what was agreed to. A provider that now says the
    // insertion fee is four pounds has changed the decision.
    const fixture = await seed();
    const { proposal, channel } = await createDraft(fixture);

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: proposal.operationId,
      adapter: channel,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: publication.operationId,
      subject: fixture.owner,
      // What the reviewer would send back after a screen quoting different fees.
      fingerprint: 'a fingerprint from a differently priced screen',
      hasRecentAuthentication: true,
      now: at(3 * MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_preview' });
  });
});

describe('executePublication', () => {
  it('publishes only after the second confirmation', async () => {
    const fixture = await seed();
    const { proposal, channel } = await createDraft(fixture);

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: proposal.operationId,
      adapter: channel,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });

    expect(channel.published).toHaveLength(0);

    await confirm(fixture, publication.operationId, publication.fingerprint, at(3 * MINUTE));
    const published = await executePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: publication.operationId,
      adapter: channel,
    });

    expect(published.externalListingId).toBe('LISTING-DRAFT-1');
    expect(published.revisableOnlyThroughApi).toBe(true);
    expect(channel.published).toEqual(['LISTING-DRAFT-1']);
  });

  it('records who published what, and under which permission', async () => {
    const fixture = await seed();
    const { proposal, channel } = await createDraft(fixture);

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: proposal.operationId,
      adapter: channel,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });
    await confirm(fixture, publication.operationId, publication.fingerprint, at(3 * MINUTE));
    await executePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: publication.operationId,
      adapter: channel,
    });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId, { limit: 50 });
    const published = events.find((event) => event.action === 'listing.draft.published');

    expect(published).toBeDefined();
    expect(published?.actorUserId).toBe(fixture.userId);
    expect(published?.detail).toMatchObject({ permission: 'publish_products' });
  });

  it('cannot publish twice under one confirmation', async () => {
    const fixture = await seed();
    const { proposal, channel } = await createDraft(fixture);

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: proposal.operationId,
      adapter: channel,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });
    await confirm(fixture, publication.operationId, publication.fingerprint, at(3 * MINUTE));

    const run = async () =>
      executePublication(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: publication.operationId,
        adapter: channel,
      });

    await run();
    await expect(run()).rejects.toBeInstanceOf(DraftRefused);
    expect(channel.published).toHaveLength(1);
  });
});
