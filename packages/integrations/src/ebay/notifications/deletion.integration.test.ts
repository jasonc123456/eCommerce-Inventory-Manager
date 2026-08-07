import {
  businesses,
  connections,
  marketplaceDeletionOutcomes,
  marketplaceDeletionRequests,
  memberships,
  providerOrders,
  users,
  webhookDeliveries,
} from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMarketplaceDeletion, type MarketplaceDeletion } from './deletion';
import type { SignatureVerifier } from './signature';

/**
 * Erasing a buyer across the whole installation.
 *
 * Two things are being proved. That a verified request actually removes the
 * person — not marks them, not schedules them — from every business that held
 * them. And that an unverified one removes nothing, because this endpoint's
 * address is public and its effect is destruction.
 */

const TOKEN = 'd'.repeat(48);
const ENDPOINT = 'https://inventory.example.invalid/api/webhooks/ebay/account-deletion';

let harness: TestDatabase;
let deletion: MarketplaceDeletion;
let verdict: 'verified' | 'mismatch' = 'verified';

const verifier: SignatureVerifier = {
  verify: () =>
    Promise.resolve(
      verdict === 'verified'
        ? { verified: true, keyId: 'key-1' }
        : { verified: false, reason: 'mismatch' },
    ),
};

beforeAll(async () => {
  harness = await createTestDatabase();
  deletion = createMarketplaceDeletion({
    db: harness.db,
    verifier,
    endpoint: ENDPOINT,
    verificationToken: TOKEN,
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seedOrder(buyer: string | null, options: { withDelivery?: boolean } = {}) {
  const slug = `ebay-deletion-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid` })
    .returning({ id: users.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: user!.id, role: 'owner' });

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId: business!.id,
      provider: 'ebay',
      environment: 'production',
      externalAccountId: slug,
      displayName: 'Seller',
      status: 'active',
      connectedAt: new Date('2026-01-01T00:00:00Z'),
    })
    .returning({ id: connections.id });

  const externalId = `order-${slug}`;

  await harness.db.insert(providerOrders).values({
    businessId: business!.id,
    connectionId: connection!.id,
    externalId,
    providerStatus: 'NOT_STARTED',
    totalAmount: '19.99',
    totalCurrency: 'USD',
    buyerExternalId: buyer,
    raw: {
      orderId: externalId,
      buyer: { username: buyer, buyerRegistrationAddress: { fullName: 'A Person' } },
      pricingSummary: { total: { value: '19.99' } },
    },
  });

  if (options.withDelivery === true) {
    await harness.db.insert(webhookDeliveries).values({
      businessId: business!.id,
      connectionId: connection!.id,
      topic: 'ORDER_SALE_COMPLETED',
      externalDeliveryId: `delivery-${slug}`,
      resourceType: 'order',
      resourceId: externalId,
      signatureVerified: true,
      rawBody: JSON.stringify({ data: { buyer: { username: buyer } } }),
    });
  }

  return { businessId: business!.id, connectionId: connection!.id, externalId };
}

function notification(buyer: string, notificationId = `del-${String((counter += 1))}`): string {
  return JSON.stringify({
    metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0' },
    notification: {
      notificationId,
      eventDate: '2026-03-01T10:00:00.000Z',
      data: { username: buyer, userId: `uid-${buyer}`, eiasToken: `eias-${buyer}` },
    },
  });
}

describe('challenge', () => {
  it('answers eBay endpoint validation', () => {
    expect(deletion.challenge('abc123')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to answer an empty challenge', () => {
    expect(deletion.challenge('')).toBeNull();
  });
});

describe('receive', () => {
  it('erases the buyer from every business that held them', async () => {
    // D-137: one endpoint for the application, several businesses holding the
    // same buyer. Reporting success after the first would be a false
    // compliance claim about the others.
    const buyer = `buyer-${String((counter += 1))}`;
    const first = await seedOrder(buyer, { withDelivery: true });
    const second = await seedOrder(buyer);
    const untouched = await seedOrder(`someone-else-${String(counter)}`);

    const outcome = await deletion.receive({
      body: notification(buyer),
      signatureHeader: 'signed',
    });

    expect(outcome).toMatchObject({
      ok: true,
      summary: { status: 'completed', businesses: 2, recordsAffected: 2, duplicate: false },
    });

    for (const business of [first, second]) {
      const [order] = await harness.db
        .select()
        .from(providerOrders)
        .where(eq(providerOrders.businessId, business.businessId));

      expect(order?.buyerExternalId).toBeNull();
      // Gone, not marked. The order survives as a business record; the person
      // does not survive in it.
      expect(JSON.stringify(order?.raw)).not.toContain(buyer);
      expect(JSON.stringify(order?.raw)).toContain('pricingSummary');
    }

    const [other] = await harness.db
      .select()
      .from(providerOrders)
      .where(eq(providerOrders.businessId, untouched.businessId));

    expect(other?.buyerExternalId).not.toBeNull();
  });

  it('clears the raw notification payloads that carried the same buyer', async () => {
    const buyer = `buyer-${String((counter += 1))}`;
    const business = await seedOrder(buyer, { withDelivery: true });

    await deletion.receive({ body: notification(buyer), signatureHeader: 'signed' });

    const [delivery] = await harness.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.businessId, business.businessId));

    expect(delivery?.rawBody).toBeNull();
    // The delivery record itself remains: it is evidence that an event was
    // received, and it no longer says anything about a person.
    expect(delivery?.topic).toBe('ORDER_SALE_COMPLETED');
  });

  it('leaves a receipt that counts records and names nobody', async () => {
    const buyer = `buyer-${String((counter += 1))}`;
    await seedOrder(buyer);

    const outcome = await deletion.receive({
      body: notification(buyer),
      signatureHeader: 'signed',
    });

    if (!outcome.ok) {
      throw new Error('expected the deletion to be accepted');
    }

    const outcomes = await harness.db
      .select()
      .from(marketplaceDeletionOutcomes)
      .where(eq(marketplaceDeletionOutcomes.requestId, outcome.summary.requestId));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.summary).toContain('1 order anonymized');
    expect(JSON.stringify(outcomes)).not.toContain(buyer);
  });

  it('erases nothing when the signature does not verify', async () => {
    const buyer = `buyer-${String((counter += 1))}`;
    const business = await seedOrder(buyer);

    verdict = 'mismatch';
    const outcome = await deletion.receive({
      body: notification(buyer),
      signatureHeader: 'forged',
    });
    verdict = 'verified';

    expect(outcome).toMatchObject({ ok: false, refusal: 'unverified' });

    const [order] = await harness.db
      .select()
      .from(providerOrders)
      .where(eq(providerOrders.businessId, business.businessId));

    expect(order?.buyerExternalId).toBe(buyer);
  });

  it('records an unverified attempt as evidence, and the database keeps it inert', async () => {
    const buyer = `buyer-${String((counter += 1))}`;

    verdict = 'mismatch';
    const outcome = await deletion.receive({
      body: notification(buyer, 'forged-1'),
      signatureHeader: 'forged',
    });
    verdict = 'verified';

    expect(outcome).toMatchObject({ ok: false, refusal: 'unverified' });

    const [row] = await harness.db
      .select()
      .from(marketplaceDeletionRequests)
      .where(eq(marketplaceDeletionRequests.notificationId, 'forged-1'));

    expect(row).toMatchObject({ verified: false, status: 'rejected' });
  });

  it('does not let a forged notification identifier block the genuine erasure', async () => {
    // The unique index on the identifier is what deduplicates redeliveries.
    // Left alone it would also let an attacker pre-register an identifier and
    // permanently prevent a real deletion — a compliance failure caused on
    // purpose.
    const buyer = `buyer-${String((counter += 1))}`;
    const business = await seedOrder(buyer);

    verdict = 'mismatch';
    await deletion.receive({ body: notification(buyer, 'contested'), signatureHeader: 'forged' });
    verdict = 'verified';

    const outcome = await deletion.receive({
      body: notification(buyer, 'contested'),
      signatureHeader: 'signed',
    });

    expect(outcome).toMatchObject({ ok: true, summary: { recordsAffected: 1 } });

    const [order] = await harness.db
      .select()
      .from(providerOrders)
      .where(eq(providerOrders.businessId, business.businessId));

    expect(order?.buyerExternalId).toBeNull();
  });

  it('treats a redelivery as the same request rather than a second erasure', async () => {
    const buyer = `buyer-${String((counter += 1))}`;
    await seedOrder(buyer);
    const body = notification(buyer, 'repeated');

    const first = await deletion.receive({ body, signatureHeader: 'signed' });
    const second = await deletion.receive({ body, signatureHeader: 'signed' });

    expect(first).toMatchObject({ ok: true, summary: { duplicate: false, recordsAffected: 1 } });
    // Re-running would find nothing and report zero, which reads like a
    // failure of an erasure that in fact succeeded.
    expect(second).toMatchObject({ ok: true, summary: { duplicate: true, recordsAffected: 1 } });

    const rows = await harness.db
      .select()
      .from(marketplaceDeletionRequests)
      .where(eq(marketplaceDeletionRequests.notificationId, 'repeated'));

    expect(rows).toHaveLength(1);
  });

  it('completes a request for a buyer this installation has never held', async () => {
    const outcome = await deletion.receive({
      body: notification(`stranger-${String((counter += 1))}`),
      signatureHeader: 'signed',
    });

    expect(outcome).toMatchObject({
      ok: true,
      summary: { status: 'completed', businesses: 0, recordsAffected: 0 },
    });
  });

  it('is idempotent: a second genuine request finds nothing left', async () => {
    const buyer = `buyer-${String((counter += 1))}`;
    await seedOrder(buyer);

    await deletion.receive({ body: notification(buyer, 'first'), signatureHeader: 'signed' });
    const again = await deletion.receive({
      body: notification(buyer, 'second'),
      signatureHeader: 'signed',
    });

    expect(again).toMatchObject({ ok: true, summary: { businesses: 0, recordsAffected: 0 } });
  });

  it('refuses a body that is not a deletion notification', async () => {
    for (const body of [
      'not json',
      JSON.stringify({ metadata: { topic: 'ORDER_SALE_COMPLETED' } }),
      JSON.stringify({ metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' } }),
      JSON.stringify({
        metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' },
        notification: { notificationId: 'n', data: {} },
      }),
    ]) {
      await expect(deletion.receive({ body, signatureHeader: 'signed' })).resolves.toEqual({
        ok: false,
        refusal: 'unreadable',
      });
    }
  });

  it('refuses an oversized body', async () => {
    await expect(
      deletion.receive({ body: 'x'.repeat(70 * 1024), signatureHeader: 'signed' }),
    ).resolves.toEqual({ ok: false, refusal: 'too_large' });
  });
});

describe('retry', () => {
  it('refuses to act on a request that was never verified', async () => {
    verdict = 'mismatch';
    await deletion.receive({
      body: notification('nobody', 'unverified-retry'),
      signatureHeader: 'forged',
    });
    verdict = 'verified';

    const [row] = await harness.db
      .select()
      .from(marketplaceDeletionRequests)
      .where(eq(marketplaceDeletionRequests.notificationId, 'unverified-retry'));

    await expect(deletion.retry(row!.id)).resolves.toEqual({ ok: false, refusal: 'unverified' });
  });

  it('finishes a business whose erasure had not run', async () => {
    // The state a partial failure leaves behind: a request recorded, one
    // business done, another still holding the data.
    const buyer = `buyer-${String((counter += 1))}`;
    await seedOrder(buyer);

    const outcome = await deletion.receive({
      body: notification(buyer, 'retryable'),
      signatureHeader: 'signed',
    });

    if (!outcome.ok) {
      throw new Error('expected the deletion to be accepted');
    }

    // A second business acquires the same buyer afterwards, standing in for one
    // that could not be reached on the first pass.
    const late = await seedOrder(buyer);

    const retried = await deletion.retry(outcome.summary.requestId);

    expect(retried).toMatchObject({ ok: true, summary: { status: 'completed' } });

    const [order] = await harness.db
      .select()
      .from(providerOrders)
      .where(eq(providerOrders.businessId, late.businessId));

    expect(order?.buyerExternalId).toBeNull();
  });

  it('refuses a request that does not exist', async () => {
    await expect(deletion.retry('00000000-0000-0000-0000-000000000000')).resolves.toEqual({
      ok: false,
      refusal: 'unverified',
    });
  });
});
