import { loadKeyring } from '@eim/crypto';
import {
  businesses,
  connectionCursors,
  connectionSecrets,
  connections,
  providerItems,
  providerOrders,
  providerWebhooks,
  users,
} from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { disconnect, previewDisconnect } from './disconnect';
import { createSecretStore, type SecretStore } from './secrets';

/**
 * Taking a connection out of service (sections 13, 14).
 *
 * Section 14's clauses are the assertions: preview impact, pause, delete only
 * app-created webhooks, discard credentials, retain non-sensitive history. The
 * two worth a real database are the last two — that every credential really is
 * unusable afterwards, and that the imported catalog really does survive.
 */

let harness: TestDatabase;
let secrets: SecretStore;

const NOW = new Date('2026-03-01T12:00:00Z');

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 5).toString('base64') }]),
      activeVersion: 1,
    }),
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

interface Seeded {
  businessId: string;
  connectionId: string;
  managedWebhookId: string;
  handMadeWebhookId: string;
}

async function seed(): Promise<Seeded> {
  const slug = `disc-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Owner' })
    .returning({ id: users.id });

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId: business!.id,
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `https://${slug}.example`,
      displayName: slug,
      status: 'active',
      connectedAt: NOW,
      activatedAt: NOW,
      createdByUserId: user!.id,
    })
    .returning({ id: connections.id });

  const ref = { businessId: business!.id, connectionId: connection!.id };

  for (const [secretType, value] of [
    ['woocommerce_consumer_key', 'ck_test'],
    ['woocommerce_consumer_secret', 'cs_test'],
  ] as const) {
    await secrets.put({ ...ref, secretType, value });
  }

  const [managed] = await harness.db
    .insert(providerWebhooks)
    .values({
      ...ref,
      topic: 'product.updated',
      externalId: '7',
      deliveryUrl: 'https://inventory.example.invalid/hook',
      appManaged: true,
      status: 'active',
    })
    .returning({ id: providerWebhooks.id });

  // Made by a person at the store: no provider identifier, so nothing here can
  // delete it even in principle.
  const [handMade] = await harness.db
    .insert(providerWebhooks)
    .values({
      ...ref,
      topic: 'order.created',
      externalId: null,
      deliveryUrl: 'https://inventory.example.invalid/hook',
      appManaged: true,
      status: 'active',
    })
    .returning({ id: providerWebhooks.id });

  await secrets.put({
    ...ref,
    secretType: 'webhook_secret',
    scope: managed!.id,
    value: 'hook-secret',
  });

  await harness.db.insert(providerItems).values({
    ...ref,
    externalId: '1',
    kind: 'product',
    inventoryEligible: true,
  });

  await harness.db.insert(providerOrders).values({
    ...ref,
    externalId: '501',
    buyerExternalId: '3',
  });

  await harness.db.insert(connectionCursors).values({
    ...ref,
    stream: 'woocommerce_products',
    cursorValue: '3',
  });

  return {
    ...ref,
    managedWebhookId: managed!.id,
    handMadeWebhookId: handMade!.id,
  };
}

describe('previewing a disconnection', () => {
  it('counts what goes and what stays', async () => {
    const ref = await seed();
    const preview = await previewDisconnect(harness.db, ref);

    expect(preview).toMatchObject({
      provider: 'woocommerce',
      retained: { items: 1, orders: 1 },
      webhooksToDelete: 1,
      credentials: 3,
      cursors: 1,
    });

    // Section 14: manually created webhooks are listed for user cleanup and
    // never automatically deleted.
    expect(preview?.webhooksToLeave).toEqual([{ topic: 'order.created' }]);
  });

  it('reports nothing for a connection in another business', async () => {
    const owner = await seed();
    const stranger = await seed();

    await expect(
      previewDisconnect(harness.db, {
        businessId: stranger.businessId,
        connectionId: owner.connectionId,
      }),
    ).resolves.toBeNull();
  });

  it('changes nothing', async () => {
    // A preview that quietly disconnected is the failure the two-call shape
    // exists to design out.
    const ref = await seed();

    await previewDisconnect(harness.db, ref);

    const [row] = await harness.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, ref.connectionId));

    expect(row?.status).toBe('active');
    await expect(secrets.read(ref, 'woocommerce_consumer_key')).resolves.toBe('ck_test');
  });
});

describe('disconnecting', () => {
  it('discards every credential', async () => {
    const ref = await seed();

    await disconnect({ db: harness.db, secrets }, { ...ref, now: NOW });

    await expect(secrets.read(ref, 'woocommerce_consumer_key')).resolves.toBeNull();
    await expect(secrets.read(ref, 'woocommerce_consumer_secret')).resolves.toBeNull();
    await expect(secrets.read(ref, 'webhook_secret', ref.managedWebhookId)).resolves.toBeNull();

    const live = await harness.db
      .select({ id: connectionSecrets.id })
      .from(connectionSecrets)
      .where(
        and(
          eq(connectionSecrets.connectionId, ref.connectionId),
          isNull(connectionSecrets.retiredAt),
        ),
      );

    expect(live).toEqual([]);
  });

  it('keeps the imported history', async () => {
    // Section 14 retains non-sensitive history: it is what an operator looks at
    // afterwards to understand what a mapping used to point at.
    const ref = await seed();

    await disconnect({ db: harness.db, secrets }, { ...ref, now: NOW });

    const items = await harness.db
      .select({ id: providerItems.id })
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    const orders = await harness.db
      .select({ id: providerOrders.id })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, ref.connectionId));

    expect(items).toHaveLength(1);
    expect(orders).toHaveLength(1);
  });

  it('forgets where the import had reached', async () => {
    // A reconnection re-imports from the beginning rather than resuming inside a
    // traversal that may no longer describe anything.
    const ref = await seed();

    await disconnect({ db: harness.db, secrets }, { ...ref, now: NOW });

    const cursors = await harness.db
      .select({ stream: connectionCursors.stream })
      .from(connectionCursors)
      .where(eq(connectionCursors.connectionId, ref.connectionId));

    expect(cursors).toEqual([]);
  });

  it('deletes only the registrations it created at the provider', async () => {
    const ref = await seed();
    const asked: string[] = [];

    const outcome = await disconnect(
      {
        db: harness.db,
        secrets,
        deleteWebhook: (input) => {
          asked.push(input.externalId);

          return Promise.resolve(true);
        },
      },
      { ...ref, now: NOW },
    );

    expect(asked).toEqual(['7']);
    expect(outcome).toMatchObject({ webhooksDeleted: 1, webhooksFailed: 0 });

    const rows = await harness.db
      .select({ status: providerWebhooks.status })
      .from(providerWebhooks)
      .where(eq(providerWebhooks.connectionId, ref.connectionId));

    expect(rows.every((row) => row.status === 'deleted')).toBe(true);
  });

  it('discards the credentials even when the provider cannot be reached', async () => {
    // A store that is down must not keep this application's key alive. The local
    // half completes and the operator is told what is left at the store.
    const ref = await seed();

    const outcome = await disconnect(
      { db: harness.db, secrets, deleteWebhook: () => Promise.resolve(false) },
      { ...ref, now: NOW },
    );

    expect(outcome).toMatchObject({ webhooksDeleted: 0, webhooksFailed: 1 });
    await expect(secrets.read(ref, 'woocommerce_consumer_key')).resolves.toBeNull();

    const [row] = await harness.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, ref.connectionId));

    expect(row?.status).toBe('disconnected');
  });

  it('records when it happened, which the database insists on', async () => {
    const ref = await seed();

    await disconnect({ db: harness.db, secrets }, { ...ref, now: NOW });

    const [row] = await harness.db
      .select({ status: connections.status, disconnectedAt: connections.disconnectedAt })
      .from(connections)
      .where(eq(connections.id, ref.connectionId));

    expect(row).toMatchObject({ status: 'disconnected', disconnectedAt: NOW });
  });

  it('leaves a connection in another business alone', async () => {
    const owner = await seed();
    const stranger = await seed();

    await disconnect(
      { db: harness.db, secrets },
      { businessId: stranger.businessId, connectionId: owner.connectionId, now: NOW },
    );

    const [row] = await harness.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, owner.connectionId));

    expect(row?.status).toBe('active');
  });

  it('can be reconnected afterwards', async () => {
    // The unique index permits one *live* connection per account, so a
    // disconnected one must not block the account being connected again.
    const ref = await seed();

    await disconnect({ db: harness.db, secrets }, { ...ref, now: NOW });

    const [row] = await harness.db
      .select({ externalAccountId: connections.externalAccountId })
      .from(connections)
      .where(eq(connections.id, ref.connectionId));

    await expect(
      harness.db.insert(connections).values({
        businessId: ref.businessId,
        provider: 'woocommerce',
        environment: 'production',
        externalAccountId: row!.externalAccountId,
        displayName: 'reconnected',
        status: 'active',
        connectedAt: NOW,
      }),
    ).resolves.toBeTruthy();
  });
});
