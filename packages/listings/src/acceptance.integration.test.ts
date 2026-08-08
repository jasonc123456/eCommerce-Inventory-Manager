import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import {
  businesses,
  connections,
  reviewedOperationRefusals,
  reviewedOperations,
  users,
} from '@eim/db';
import { FakeChannelAdapter } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  executeDraftCreation,
  executePublication,
  proposeDraft,
  proposePublication,
} from './drafts';
import { executeOrderCopy, proposeOrderCopy } from './order-copy';
import { executePriceCopy, proposePriceCopy } from './prices';
import { confirmOperation } from './review';
import type { SuppressionTechnique } from './suppression';

/**
 * The M5 exit gate (section 36).
 *
 * "No auto-publication/recurring-price path exists; confirmation, fee,
 * permission, freshness, idempotency, and audit tests pass."
 *
 * Seven claims, and the first two are different in kind from the rest. The five
 * that follow are properties of the code as written and are demonstrated by
 * exercising it. The first two are claims about what the code *cannot* be made
 * to do, and a test that merely fails to find an automatic publication today
 * proves very little about tomorrow — so those are asserted structurally as well
 * as behaviourally: against the dependency graph, against the schema, and
 * against the state machine's refusal to be revived.
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
  readonly sourceConnectionId: string;
  readonly destinationConnectionId: string;
}

async function seed(): Promise<Fixture> {
  const slug = `gate-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Reviewer' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const userId = user!.id;

  const [ebay] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'sandbox',
      externalAccountId: `ebay-${slug}`,
      displayName: 'Seller',
      status: 'active',
    })
    .returning({ id: connections.id });
  const [store] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `store-${slug}`,
      displayName: 'Shop',
      status: 'active',
    })
    .returning({ id: connections.id });

  return {
    businessId,
    userId,
    owner: { userId, isOwner: true, grants: [] },
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
    sourceConnectionId: ebay!.id,
    destinationConnectionId: store!.id,
  };
}

const base = new Date('2026-03-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(base.getTime() + offsetMs);
const MINUTE = 60_000;
const REPO = join(import.meta.dirname, '..', '..', '..');

function channel(): FakeChannelAdapter {
  return new FakeChannelAdapter({
    listingOperations: true,
    initialPrices: new Map([['ITEM-1', { amount: '15.00', currency: 'GBP' }]]),
    initialQuantities: new Map([['ITEM-1', 0]]),
  });
}

const proven: readonly SuppressionTechnique[] = [
  { name: 'mark_order_stock_reduced', minimumVersion: '8.0.0', verified: true },
];

const subject = {
  title: 'Brass garden hose fitting',
  description: 'A fitting, made of brass.',
  sku: 'HOSE-BRASS-1',
  price: { amount: '12.50', currency: 'GBP' },
  quantity: 7,
  imageUrls: ['https://example.invalid/hose.jpg'],
  categoryHints: ['Garden'],
  unmodelledFields: [],
};

async function confirm(fixture: Fixture, operationId: string, fingerprint: string, now: Date) {
  return confirmOperation(harness.db, {
    businessId: fixture.businessId,
    operationId,
    subject: fixture.owner,
    fingerprint,
    hasRecentAuthentication: true,
    now,
  });
}

/** A draft proposed, confirmed, and created — the starting point for publication. */
async function draftFor(fixture: Fixture, adapter: FakeChannelAdapter) {
  const proposal = await proposeDraft(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    destination: 'woocommerce',
    destinationConnectionId: fixture.destinationConnectionId,
    source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
    subject,
    selections: { categories: ['Garden'], taxStatus: 'taxable', catalogVisibility: 'visible' },
    sourceObservedAt: base,
    actorUserId: fixture.userId,
    subjectKey: `listing:${String((counter += 1))}`,
    now: base,
  });

  await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
  await executeDraftCreation(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    operationId: proposal.operationId,
    adapter,
  });

  return proposal;
}

async function priceCopyFor(fixture: Fixture, adapter: FakeChannelAdapter) {
  return proposePriceCopy(harness.db, fixture.audit, {
    businessId: fixture.businessId,
    source: { label: 'eBay', amount: '12.50', currency: 'GBP' },
    destinationConnectionId: fixture.destinationConnectionId,
    destinationEntity: { externalId: 'ITEM-1' },
    destinationLabel: 'the shop',
    adapter,
    actorUserId: fixture.userId,
    now: base,
  });
}

describe('no automatic publication path exists', () => {
  it('keeps the automatic tier unable to reach these operations at all', () => {
    // The lint rule is the enforcement; this is the assertion that the rule is
    // still there and still names the right packages. A test that only checked
    // behaviour would pass on the day somebody wired a publication into a job
    // and forgot the boundary.
    const config = readFileSync(join(REPO, 'eslint.config.js'), 'utf8');

    expect(config).toContain('@eim/listings');
    expect(config).toMatch(/packages\/sync\/\*\*\/\*\.ts.*\n?.*packages\/jobs/s);
    expect(config).toContain('apps/worker/**/*.ts');
  });

  it('is not a dependency of anything that runs unattended', () => {
    // Belt as well as braces: even with the lint rule intact, a package that
    // declared the dependency would be one import away from using it.
    for (const unattended of ['packages/sync', 'packages/jobs', 'apps/worker']) {
      const manifest = readFileSync(join(REPO, unattended, 'package.json'), 'utf8');
      expect(manifest).not.toContain('@eim/listings');
    }
  });

  it('registers no background job that could carry one out', () => {
    // Every job kind the scheduler knows about is declared in `packages/sync`.
    // None of them names a listing operation, and none can, because the module
    // that performs them cannot be imported there.
    const sync = join(REPO, 'packages/sync/src');
    const sources = readdirSync(sync).filter(
      (name) => name.endsWith('.ts') && !name.includes('.test.'),
    );

    for (const name of sources) {
      const source = readFileSync(join(sync, name), 'utf8');
      expect(source).not.toContain('@eim/listings');
    }
  });

  it('never produces a published status from a draft projection', async () => {
    const fixture = await seed();
    const adapter = channel();
    await draftFor(fixture, adapter);

    // Section 30's US-11: publication is impossible from the draft action.
    expect(adapter.drafts[0]?.fields['status']).toBe('draft');
    expect(adapter.published).toHaveLength(0);
  });

  it('publishes only after a second, separate confirmation', async () => {
    const fixture = await seed();
    const adapter = channel();
    const draft = await draftFor(fixture, adapter);

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: draft.operationId,
      adapter,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });

    // Proposed and quoted, and still nothing is live.
    expect(adapter.published).toHaveLength(0);

    await confirm(fixture, publication.operationId, publication.fingerprint, at(3 * MINUTE));
    await executePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: publication.operationId,
      adapter,
    });

    expect(adapter.published).toHaveLength(1);
  });
});

describe('no recurring price path exists', () => {
  it('has nowhere in the schema to put a schedule', () => {
    // The absence is the guarantee. A recurring feature would have to add a
    // table, which a reviewer sees, rather than set a column nobody noticed.
    const migration = readFileSync(
      join(REPO, 'packages/db/migrations/0021_reviewed_operations.sql'),
      'utf8',
    );

    // Comments stripped first. The file explains at length why there is no
    // schedule, and the words it uses to say so are the words being searched
    // for — checking the prose would fail on the paragraph that promises the
    // very thing being asserted.
    const declarations = migration
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .toLowerCase();

    for (const forbidden of ['interval', 'next_run', 'repeat', 'cron', 'recurring']) {
      expect(declarations).not.toContain(forbidden);
    }
  });

  it('applies one confirmation exactly once and then settles', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));

    await executePriceCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter,
    });

    // Somebody edits the price in their own shop afterwards. Section 14:
    // "external price edits refresh comparisons and are not overwritten
    // automatically." Nothing re-applies the confirmed figure over it.
    adapter.setPriceOutOfBand({ externalId: 'ITEM-1' }, '30.00', 'GBP');

    expect(adapter.priceWrites).toHaveLength(1);
    expect(adapter.priceOf({ externalId: 'ITEM-1' })).toEqual({
      amount: '30.00',
      currency: 'GBP',
    });
  });

  it('refuses to revive an executed operation into a state that could run again', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
    await executePriceCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter,
    });

    let refusal = '';
    try {
      await harness.db
        .update(reviewedOperations)
        .set({ state: 'confirmed' })
        .where(eq(reviewedOperations.id, proposal.operationId));
    } catch (error) {
      const cause: unknown = error instanceof Error ? error.cause : undefined;
      refusal = cause instanceof Error ? cause.message : String(error);
    }

    expect(refusal).toMatch(/already executed/);
  });
});

describe('confirmation', () => {
  it('is required before anything reaches a provider, for every kind', async () => {
    const fixture = await seed();
    const adapter = channel();

    // A draft, proposed and left alone.
    const draft = await proposeDraft(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      destination: 'woocommerce',
      destinationConnectionId: fixture.destinationConnectionId,
      source: { platform: 'ebay', format: 'fixed_price', variationCount: 1, state: 'active' },
      subject,
      sourceObservedAt: base,
      actorUserId: fixture.userId,
      subjectKey: 'listing:unconfirmed-gate',
      now: base,
    });
    await expect(
      executeDraftCreation(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: draft.operationId,
        adapter,
      }),
    ).rejects.toThrow();

    // A price copy, likewise.
    const price = await priceCopyFor(fixture, adapter);
    await expect(
      executePriceCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: price.operationId,
        adapter,
      }),
    ).rejects.toThrow();

    expect(adapter.drafts).toHaveLength(0);
    expect(adapter.priceWrites).toHaveLength(0);
  });

  it('binds to the exact values that were shown', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: 'the fingerprint of a different screen',
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_preview' });
  });
});

describe('fee impact', () => {
  it('is quoted before a publication is confirmed, and is part of the agreement', async () => {
    const fixture = await seed();
    const adapter = channel();
    const draft = await draftFor(fixture, adapter);

    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: draft.operationId,
      adapter,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });

    expect(publication.fees.length).toBeGreaterThan(0);
    expect(publication.totalAmount).toBe('1.55');

    const preview = (
      await harness.db
        .select({ preview: reviewedOperations.preview })
        .from(reviewedOperations)
        .where(eq(reviewedOperations.id, publication.operationId))
    )[0]?.preview as { fees: unknown[] };
    expect(preview.fees).toHaveLength(2);
  });

  it('is quoted before a price change is confirmed', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);

    expect(adapter.calls).toContain('previewPriceChange');
    expect(proposal.totalFees).toBe('1.25');
  });
});

describe('permission', () => {
  it('demands the right one for each kind', async () => {
    const fixture = await seed();
    const adapter = channel();

    const draft = await draftFor(fixture, adapter);
    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: draft.operationId,
      adapter,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });
    const price = await priceCopyFor(fixture, adapter);

    const rows = await harness.db
      .select({
        id: reviewedOperations.id,
        permission: reviewedOperations.requiredPermission,
        stepUp: reviewedOperations.requiresRecentAuthentication,
      })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.businessId, fixture.businessId));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(draft.operationId)?.permission).toBe('create_drafts');
    expect(byId.get(publication.operationId)?.permission).toBe('publish_products');
    expect(byId.get(price.operationId)?.permission).toBe('change_prices');

    // Publishing and pricing both need a recent sign-in; drafting does not.
    expect(byId.get(publication.operationId)?.stepUp).toBe(true);
    expect(byId.get(price.operationId)?.stepUp).toBe(true);
    expect(byId.get(draft.operationId)?.stepUp).toBe(false);
  });

  it('refuses a member who does not hold it', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: { userId: fixture.userId, isOwner: false, grants: [] },
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'not_permitted' });
  });

  it('refuses a session that has not authenticated recently enough', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: false,
      now: at(MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'recent_authentication_required' });
  });
});

describe('freshness', () => {
  it('refuses a confirmation against values that have gone stale', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);

    const outcome = await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(6 * MINUTE),
    });

    expect(outcome).toMatchObject({ confirmed: false, reason: 'stale_source' });
    expect(adapter.priceWrites).toHaveLength(0);
  });

  it('settles a proposal nobody came back to', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);

    await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: proposal.fingerprint,
      hasRecentAuthentication: true,
      now: at(20 * MINUTE),
    });

    const [row] = await harness.db
      .select({ state: reviewedOperations.state })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));
    expect(row?.state).toBe('expired');
  });
});

describe('idempotency', () => {
  it('has one provider effect per confirmation, however often it is retried', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));

    const run = async () =>
      executePriceCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter,
      });

    await run();
    await expect(run()).rejects.toThrow();
    await expect(run()).rejects.toThrow();

    expect(adapter.priceWrites).toHaveLength(1);
  });

  it('carries one key across every attempt at a copied order', async () => {
    const fixture = await seed();
    const adapter = channel();

    const proposal = await proposeOrderCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      subject: {
        sourceOrderId: 'EBAY-GATE-1',
        sourceConnectionId: fixture.sourceConnectionId,
        fulfilled: false,
        currency: 'GBP',
        lines: [
          {
            sourceLineId: 'L1',
            sku: 'HOSE-BRASS-1',
            name: 'Brass garden hose fitting',
            quantity: 1,
            unitAmount: '12.50',
            totalAmount: '12.50',
          },
        ],
        totalAmount: '12.50',
      },
      destinationConnectionId: fixture.destinationConnectionId,
      destinationWooVersion: '9.4.2',
      actorUserId: fixture.userId,
      techniques: proven,
      sourceObservedAt: base,
      now: base,
    });

    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
    await executeOrderCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter,
    });

    await expect(
      executeOrderCopy(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        operationId: proposal.operationId,
        adapter,
      }),
    ).rejects.toThrow();

    expect(adapter.mirroredOrders).toHaveLength(1);
  });
});

describe('audit', () => {
  it('records the proposal, the effect, and the actor behind both', async () => {
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);
    await confirm(fixture, proposal.operationId, proposal.fingerprint, at(MINUTE));
    await executePriceCopy(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      adapter,
    });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId, { limit: 50 });
    const actions = events.map((event) => event.action);

    expect(actions).toContain('listing.operation.proposed');
    expect(actions).toContain('listing.price.changed');
    for (const event of events) {
      expect(event.actorUserId).toBe(fixture.userId);
    }
  });

  it('records the refusals as well as the changes', async () => {
    // A gate with no record of ever having refused anything is
    // indistinguishable from an open door.
    const fixture = await seed();
    const adapter = channel();
    const proposal = await priceCopyFor(fixture, adapter);

    await confirmOperation(harness.db, {
      businessId: fixture.businessId,
      operationId: proposal.operationId,
      subject: fixture.owner,
      fingerprint: 'not the one on record',
      hasRecentAuthentication: true,
      now: at(MINUTE),
    });

    const refusals = await harness.db
      .select()
      .from(reviewedOperationRefusals)
      .where(eq(reviewedOperationRefusals.operationId, proposal.operationId));

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.reason).toBe('stale_preview');
    expect(refusals[0]?.attemptedByUserId).toBe(fixture.userId);

    const [row] = await harness.db
      .select({ state: reviewedOperations.state })
      .from(reviewedOperations)
      .where(eq(reviewedOperations.id, proposal.operationId));

    // Still open: a refusal is a decision about this attempt, not the operation.
    expect(row?.state).toBe('proposed');
  });

  it('names what was published and under which permission', async () => {
    const fixture = await seed();
    const adapter = channel();
    const draft = await draftFor(fixture, adapter);
    const publication = await proposePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      draftOperationId: draft.operationId,
      adapter,
      actorUserId: fixture.userId,
      now: at(2 * MINUTE),
    });
    await confirm(fixture, publication.operationId, publication.fingerprint, at(3 * MINUTE));
    await executePublication(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      operationId: publication.operationId,
      adapter,
    });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId, { limit: 50 });
    const published = events.find((event) => event.action === 'listing.draft.published');

    expect(published?.detail).toMatchObject({
      externalListingId: 'LISTING-DRAFT-1',
      permission: 'publish_products',
    });
  });
});
