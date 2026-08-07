import { businesses, connections, memberships, users, webhookDeliveries } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNotificationIntake, type NotificationIntake } from './intake';
import type { SignatureVerifier } from './signature';

/**
 * Receiving a notification.
 *
 * The signature verifier is a stub here on purpose: whether ECDSA works is
 * settled in `signature.test.ts` against real keys. What is being proved here
 * is what the intake does with a verdict — and above all that an unverified
 * body never reaches the database, because the seller identifier inside it
 * chooses which business's table would be written to.
 */

let harness: TestDatabase;
let verdict: 'verified' | 'mismatch' = 'verified';

const verifier: SignatureVerifier = {
  verify: () =>
    Promise.resolve(
      verdict === 'verified'
        ? { verified: true, keyId: 'key-1' }
        : { verified: false, reason: 'mismatch' },
    ),
};

let intake: NotificationIntake;

beforeAll(async () => {
  harness = await createTestDatabase();
  intake = createNotificationIntake({
    db: harness.db,
    environment: 'production',
    verifier,
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seedBusiness(sellerId: string) {
  const slug = `ebay-intake-${String((counter += 1))}`;

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
      externalAccountId: sellerId,
      displayName: 'Seller',
      status: 'active',
      connectedAt: new Date('2026-01-01T00:00:00Z'),
    })
    .returning({ id: connections.id });

  return { businessId: business!.id, connectionId: connection!.id };
}

function notification(overrides: {
  topic?: string;
  notificationId?: string;
  sellerId: string;
  data?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    metadata: {
      topic: overrides.topic ?? 'ORDER_SALE_COMPLETED',
      schemaVersion: '1.3',
      deprecated: false,
    },
    notification: {
      notificationId: overrides.notificationId ?? `note-${String((counter += 1))}`,
      eventDate: '2026-03-01T10:00:00.000Z',
      publishDate: '2026-03-01T10:00:01.000Z',
      publishAttemptCount: 1,
      data: { username: overrides.sellerId, ...overrides.data },
    },
  });
}

async function deliveries(connectionId: string) {
  return harness.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.connectionId, connectionId));
}

describe('receive', () => {
  it('records a verified notification before anything acts on it', async () => {
    verdict = 'verified';
    const seller = `seller-${String((counter += 1))}`;
    const connection = await seedBusiness(seller);
    const body = notification({ sellerId: seller, data: { orderId: '12-34567-89012' } });

    const outcome = await intake.receive({ body, signatureHeader: 'signed' });

    expect(outcome).toMatchObject({ ok: true, topic: 'ORDER_SALE_COMPLETED', duplicate: false });

    const rows = await deliveries(connection.connectionId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      topic: 'ORDER_SALE_COMPLETED',
      signatureVerified: true,
      // Received, not processed. The acknowledgement is honest about which of
      // those has happened.
      status: 'received',
      resourceType: 'order',
      resourceId: '12-34567-89012',
    });
    expect(rows[0]?.rawBody).toBe(body);
  });

  it('stores nothing at all when the signature does not verify', async () => {
    // The seller identifier inside an unverified body is attacker-controlled,
    // and using it to choose a table would let anyone fill any business's
    // delivery log.
    const seller = `seller-${String((counter += 1))}`;
    const connection = await seedBusiness(seller);

    verdict = 'mismatch';
    const outcome = await intake.receive({
      body: notification({ sellerId: seller }),
      signatureHeader: 'forged',
    });

    expect(outcome).toEqual({ ok: false, refusal: 'unverified', reason: 'mismatch' });
    await expect(deliveries(connection.connectionId)).resolves.toHaveLength(0);
    verdict = 'verified';
  });

  it('records one delivery per business that has connected the same seller', async () => {
    // One eBay account, connected by two businesses in the same installation.
    // Handled for one says nothing about the other.
    const seller = `seller-${String((counter += 1))}`;
    const first = await seedBusiness(seller);
    const second = await seedBusiness(seller);

    const outcome = await intake.receive({
      body: notification({ sellerId: seller }),
      signatureHeader: 'signed',
    });

    expect(outcome).toMatchObject({ ok: true });

    if (outcome.ok) {
      expect(outcome.recorded).toHaveLength(2);
    }

    await expect(deliveries(first.connectionId)).resolves.toHaveLength(1);
    await expect(deliveries(second.connectionId)).resolves.toHaveLength(1);
  });

  it('treats a redelivery as the same event rather than a second one', async () => {
    // eBay redelivers on any doubt about the answer. For an order, a second row
    // is a second stock movement.
    const seller = `seller-${String((counter += 1))}`;
    const connection = await seedBusiness(seller);
    const body = notification({ sellerId: seller, notificationId: 'note-fixed' });

    const first = await intake.receive({ body, signatureHeader: 'signed' });
    const second = await intake.receive({ body, signatureHeader: 'signed' });

    expect(first).toMatchObject({ duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    await expect(deliveries(connection.connectionId)).resolves.toHaveLength(1);
  });

  it('acknowledges a verified notification about a seller nobody has connected', async () => {
    const outcome = await intake.receive({
      body: notification({ sellerId: 'a-seller-not-here' }),
      signatureHeader: 'signed',
    });

    expect(outcome).toEqual({ ok: false, refusal: 'unattributed' });
  });

  it('does not attribute across environments', async () => {
    // Sandbox and production are separate keysets with separate sellers that
    // may share a username. Crossing them would write a rehearsal's events into
    // real inventory.
    const seller = `seller-${String((counter += 1))}`;
    await seedBusiness(seller);

    const sandbox = createNotificationIntake({
      db: harness.db,
      environment: 'sandbox',
      verifier,
    });

    await expect(
      sandbox.receive({ body: notification({ sellerId: seller }), signatureHeader: 'signed' }),
    ).resolves.toEqual({ ok: false, refusal: 'unattributed' });
  });

  it('refuses a body with no topic, identifier, or seller', async () => {
    for (const body of [
      'not json',
      JSON.stringify([]),
      JSON.stringify({ metadata: { topic: 'ORDER_SALE_COMPLETED' } }),
      JSON.stringify({ notification: { notificationId: 'n-1', data: { username: 'x' } } }),
      JSON.stringify({
        metadata: { topic: 'ORDER_SALE_COMPLETED' },
        notification: { notificationId: 'n-1', data: {} },
      }),
    ]) {
      await expect(intake.receive({ body, signatureHeader: 'signed' })).resolves.toEqual({
        ok: false,
        refusal: 'unreadable',
      });
    }
  });

  it('refuses an oversized body before verifying it', async () => {
    const outcome = await intake.receive({
      body: 'x'.repeat(300 * 1024),
      signatureHeader: 'signed',
    });

    expect(outcome).toEqual({ ok: false, refusal: 'too_large' });
  });

  it('keeps diagnostic headers and drops the signature', async () => {
    // The signature is a credential for a body that has already been verified.
    const seller = `seller-${String((counter += 1))}`;
    const connection = await seedBusiness(seller);

    await intake.receive({
      body: notification({ sellerId: seller }),
      signatureHeader: 'signed',
      headers: {
        'X-EBAY-SIGNATURE': 'a-signature',
        Authorization: 'Bearer nope',
        'Content-Type': 'application/json',
        'user-agent': 'eBay',
      },
    });

    const [row] = await deliveries(connection.connectionId);

    expect(row?.headers).toEqual({ 'content-type': 'application/json', 'user-agent': 'eBay' });
  });

  it('stores an unrecognized payload shape with no resource rather than refusing it', async () => {
    const seller = `seller-${String((counter += 1))}`;
    const connection = await seedBusiness(seller);

    await intake.receive({
      body: notification({
        sellerId: seller,
        topic: 'SOMETHING_NEW',
        data: { somethingUnknown: true },
      }),
      signatureHeader: 'signed',
    });

    const [row] = await deliveries(connection.connectionId);

    expect(row).toMatchObject({ topic: 'SOMETHING_NEW', resourceType: null, resourceId: null });
  });
});
