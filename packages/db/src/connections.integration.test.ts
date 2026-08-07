import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  businesses,
  connectionCursors,
  connectionHealth,
  connectionSecrets,
  connections,
  importRuns,
  memberships,
  permissionGrants,
  permissionGrantConnections,
  providerQuotaWindows,
  providerWebhooks,
  users,
  webhookDeliveries,
} from './index';

/**
 * Proof that the connection tables enforce what sections 13 and 14 say.
 *
 * The rules under test are the ones whose violation would be silent. A
 * duplicated connection, a webhook we did not create being managed as if we
 * had, an unverified delivery marked processed, an import claiming a sweep it
 * never completed — none of those announce themselves. They surface later as a
 * seller's quantities being written from another seller's catalog, or as a
 * deletion sweep removing listings that were merely unreached.
 *
 * Runs against real PostgreSQL 18 only. There is no fake.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

/** A business with an owner, because the final-owner trigger requires one. */
async function seedBusiness(): Promise<{
  businessId: string;
  userId: string;
  membershipId: string;
}> {
  const { db } = harness;
  const slug = `conn-${String((counter += 1))}`;

  const [business] = await db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await db
    .insert(users)
    .values({ email: `${slug}@example.invalid` })
    .returning({ id: users.id });

  const [membership] = await db
    .insert(memberships)
    .values({ businessId: business!.id, userId: user!.id, role: 'owner' })
    .returning({ id: memberships.id });

  return { businessId: business!.id, userId: user!.id, membershipId: membership!.id };
}

async function seedConnection(
  businessId: string,
  overrides: Partial<typeof connections.$inferInsert> = {},
): Promise<string> {
  const [row] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'production',
      externalAccountId: `seller-${String((counter += 1))}`,
      displayName: 'Test seller',
      status: 'active',
      connectedAt: new Date(),
      ...overrides,
    })
    .returning({ id: connections.id });

  return row!.id;
}

describe('connection identity', () => {
  it('allows the same seller in both environments, and in two businesses', async () => {
    // Sandbox and production are separate accounts that happen to share a name,
    // and two businesses in one installation may legitimately sell through the
    // same eBay seller — a bookkeeping arrangement, not an error.
    const first = await seedBusiness();
    const second = await seedBusiness();

    await seedConnection(first.businessId, {
      externalAccountId: 'shared-seller',
      environment: 'production',
    });
    await seedConnection(first.businessId, {
      externalAccountId: 'shared-seller',
      environment: 'sandbox',
    });
    await seedConnection(second.businessId, {
      externalAccountId: 'shared-seller',
      environment: 'production',
    });

    const rows = await harness.db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.externalAccountId, 'shared-seller'));

    expect(rows).toHaveLength(3);
  });

  it('refuses a second live connection to the same account', async () => {
    // Two live connections to one seller would each import the same orders and
    // each believe it owned the resulting quantities.
    const { businessId } = await seedBusiness();
    await seedConnection(businessId, { externalAccountId: 'only-once' });

    const reason = await refuses(() =>
      seedConnection(businessId, { externalAccountId: 'only-once' }),
    );

    expect(reason).toContain('connections_account_live');
  });

  it('allows reconnecting an account that was disconnected', async () => {
    const { businessId } = await seedBusiness();
    const id = await seedConnection(businessId, { externalAccountId: 'returning' });

    await harness.db
      .update(connections)
      .set({ status: 'disconnected', disconnectedAt: new Date() })
      .where(eq(connections.id, id));

    await expect(
      seedConnection(businessId, { externalAccountId: 'returning' }),
    ).resolves.toBeTruthy();
  });

  it('refuses a WooCommerce connection in a sandbox environment', async () => {
    // WooCommerce has no sandbox. A row claiming one would be a store nobody
    // could authorize, occupying the identity of the real one.
    const { businessId } = await seedBusiness();

    const reason = await refuses(() =>
      seedConnection(businessId, { provider: 'woocommerce', environment: 'sandbox' }),
    );

    expect(reason).toContain('connections_woocommerce_production_only');
  });

  it('refuses a paused connection with no reason, and a reason with no pause', async () => {
    const { businessId } = await seedBusiness();

    expect(await refuses(() => seedConnection(businessId, { status: 'paused' }))).toContain(
      'connections_pause_reason_present',
    );
    expect(
      await refuses(() => seedConnection(businessId, { pauseReason: 'scope reduced' })),
    ).toContain('connections_pause_reason_present');
  });

  it('refuses an activation that precedes any connection at all', async () => {
    const { businessId } = await seedBusiness();

    const reason = await refuses(() =>
      seedConnection(businessId, { connectedAt: null, activatedAt: new Date() }),
    );

    expect(reason).toContain('connections_activated_after_connected');
  });
});

describe('tenancy', () => {
  it('refuses to attach a secret to a connection in another business', async () => {
    // The composite foreign key is the whole point: the application cannot mix
    // businesses by writing the wrong identifier, because the row will not store.
    const owner = await seedBusiness();
    const stranger = await seedBusiness();
    const connectionId = await seedConnection(owner.businessId);

    const reason = await refuses(() =>
      harness.db.insert(connectionSecrets).values({
        businessId: stranger.businessId,
        connectionId,
        secretType: 'ebay_refresh_token',
        ciphertext: 'eim1.1.a.b.c',
        keyVersion: 1,
      }),
    );

    expect(reason).toContain('connection_secrets_connection_fkey');
  });

  it('refuses to scope a permission grant to another business’s connection', async () => {
    const owner = await seedBusiness();
    const stranger = await seedBusiness();
    const connectionId = await seedConnection(owner.businessId);

    const [grant] = await harness.db
      .insert(permissionGrants)
      .values({
        businessId: stranger.businessId,
        membershipId: stranger.membershipId,
        permission: 'delete_business',
        scopeKind: 'connections',
      })
      .returning({ id: permissionGrants.id });

    const reason = await refuses(() =>
      harness.db.insert(permissionGrantConnections).values({
        businessId: stranger.businessId,
        grantId: grant!.id,
        connectionId,
      }),
    );

    expect(reason).toContain('permission_grant_connections_connection_fkey');
  });
});

describe('credentials', () => {
  it('keeps one live secret of each kind and allows a retired one alongside', async () => {
    // Rotation overlaps deliberately (section 14): the replacement is proven
    // before the old one is retired, so both exist for a moment.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId);

    const secret = (retiredAt: Date | null) => ({
      businessId,
      connectionId,
      secretType: 'woocommerce_consumer_key' as const,
      ciphertext: 'eim1.1.a.b.c',
      keyVersion: 1,
      retiredAt,
    });

    await harness.db.insert(connectionSecrets).values(secret(null));

    expect(
      await refuses(() => harness.db.insert(connectionSecrets).values(secret(null))),
    ).toContain('connection_secrets_live');

    await harness.db
      .update(connectionSecrets)
      .set({ retiredAt: new Date() })
      .where(eq(connectionSecrets.connectionId, connectionId));

    await expect(harness.db.insert(connectionSecrets).values(secret(null))).resolves.toBeTruthy();
  });

  it('discards credentials when the connection is deleted', async () => {
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId);

    await harness.db.insert(connectionSecrets).values({
      businessId,
      connectionId,
      secretType: 'ebay_refresh_token',
      ciphertext: 'eim1.1.a.b.c',
      keyVersion: 1,
    });

    await harness.db.delete(connections).where(eq(connections.id, connectionId));

    const remaining = await harness.db
      .select({ id: connectionSecrets.id })
      .from(connectionSecrets)
      .where(eq(connectionSecrets.connectionId, connectionId));

    expect(remaining).toEqual([]);
  });
});

describe('imports', () => {
  it('permits one running import per stream and any number of finished ones', async () => {
    // Two concurrent imports of one stream interleave their cursors, and each
    // then treats the pages the other fetched as records it never saw.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId);

    const run = { businessId, connectionId, stream: 'listings' };

    await harness.db.insert(importRuns).values(run);

    expect(await refuses(() => harness.db.insert(importRuns).values(run))).toContain(
      'import_runs_one_active',
    );

    await harness.db
      .update(importRuns)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(importRuns.connectionId, connectionId));

    await expect(harness.db.insert(importRuns).values(run)).resolves.toBeTruthy();
  });

  it('refuses to claim a completed sweep on a run that did not complete', async () => {
    // This flag is the licence to delete: anything a complete scan did not see
    // is gone. A failed run claiming it would delete everything it never reached.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId);

    const reason = await refuses(() =>
      harness.db.insert(importRuns).values({
        businessId,
        connectionId,
        stream: 'orders',
        status: 'failed',
        finishedAt: new Date(),
        sweptCompletely: true,
      }),
    );

    expect(reason).toContain('import_runs_sweep_requires_completion');
  });

  it('refuses a running import that has already finished', async () => {
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId);

    const reason = await refuses(() =>
      harness.db.insert(importRuns).values({
        businessId,
        connectionId,
        stream: 'orders',
        status: 'running',
        finishedAt: new Date(),
      }),
    );

    expect(reason).toContain('import_runs_finished_recorded');
  });

  it('keeps a cursor per stream so one does not drag the other back', async () => {
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId);

    await harness.db.insert(connectionCursors).values([
      { businessId, connectionId, stream: 'orders', cursorValue: 'page-9' },
      { businessId, connectionId, stream: 'listings', cursorValue: 'page-1' },
    ]);

    const rows = await harness.db
      .select({ stream: connectionCursors.stream, value: connectionCursors.cursorValue })
      .from(connectionCursors)
      .where(eq(connectionCursors.connectionId, connectionId));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.value).sort()).toEqual(['page-1', 'page-9']);
  });
});

describe('webhooks', () => {
  it('refuses a webhook secret that does not name the registration it signs for', async () => {
    // Every other kind of credential is unique per connection. A webhook secret
    // is not: section 14 requires one per managed registration, and a rotation
    // deliberately has two live for one topic. A secret with no scope is one
    // nothing can decide the ownership of.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId, { provider: 'woocommerce' });

    const reason = await refuses(() =>
      harness.db.insert(connectionSecrets).values({
        businessId,
        connectionId,
        secretType: 'webhook_secret',
        ciphertext: 'eim1.1.a.b.c',
        keyVersion: 1,
      }),
    );

    expect(reason).toContain('connection_secrets_scope_when_webhook');
  });

  it('holds several live webhook secrets for one connection', async () => {
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId, { provider: 'woocommerce' });

    for (const scope of ['hook-a', 'hook-b', 'hook-c']) {
      await harness.db.insert(connectionSecrets).values({
        businessId,
        connectionId,
        secretType: 'webhook_secret',
        secretScope: scope,
        ciphertext: `eim1.1.${scope}.b.c`,
        keyVersion: 1,
      });
    }

    // ...and still refuses two live secrets for the same registration.
    const reason = await refuses(() =>
      harness.db.insert(connectionSecrets).values({
        businessId,
        connectionId,
        secretType: 'webhook_secret',
        secretScope: 'hook-a',
        ciphertext: 'eim1.1.duplicate.b.c',
        keyVersion: 1,
      }),
    );

    expect(reason).toContain('connection_secrets_live');
  });

  it('refuses to hold a signing secret for a webhook we did not create', async () => {
    // A webhook somebody else registered is one we may list but never manage,
    // and a secret of ours attached to it would imply otherwise.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId, { provider: 'woocommerce' });

    const [secret] = await harness.db
      .insert(connectionSecrets)
      .values({
        businessId,
        connectionId,
        secretType: 'webhook_secret',
        // A webhook secret must name the registration it signs for: several are
        // live at once, one per topic and two more during a rotation.
        secretScope: '00000000-0000-4000-8000-0000000000ff',
        ciphertext: 'eim1.1.a.b.c',
        keyVersion: 1,
      })
      .returning({ id: connectionSecrets.id });

    const reason = await refuses(() =>
      harness.db.insert(providerWebhooks).values({
        businessId,
        connectionId,
        topic: 'product.updated',
        deliveryUrl: 'https://example.invalid/hooks/woo',
        appManaged: false,
        secretId: secret!.id,
      }),
    );

    expect(reason).toContain('provider_webhooks_unmanaged_has_no_secret');
  });

  it('allows a replacement to exist beside the registration it will replace', async () => {
    // Rotation is overlapping by design: create, prove, transition, remove.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId, { provider: 'woocommerce' });

    const registration = (status: 'active' | 'replacing') => ({
      businessId,
      connectionId,
      topic: 'order.updated',
      deliveryUrl: 'https://example.invalid/hooks/woo',
      status,
    });

    await harness.db.insert(providerWebhooks).values(registration('active'));
    await expect(
      harness.db.insert(providerWebhooks).values(registration('replacing')),
    ).resolves.toBeTruthy();

    expect(
      await refuses(() => harness.db.insert(providerWebhooks).values(registration('active'))),
    ).toContain('provider_webhooks_one_active_topic');
  });

  it('refuses to mark an unverified delivery processed', async () => {
    // An unverified delivery is evidence of an attempt, not an instruction.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId, { provider: 'woocommerce' });

    const reason = await refuses(() =>
      harness.db.insert(webhookDeliveries).values({
        businessId,
        connectionId,
        topic: 'order.updated',
        signatureVerified: false,
        status: 'processed',
        processedAt: new Date(),
      }),
    );

    expect(reason).toContain('webhook_deliveries_unverified_not_processed');
  });

  it('records an unverified delivery as rejected rather than discarding it', async () => {
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId, { provider: 'woocommerce' });

    await expect(
      harness.db.insert(webhookDeliveries).values({
        businessId,
        connectionId,
        topic: 'order.updated',
        signatureVerified: false,
        status: 'rejected',
        externalDeliveryId: 'delivery-forged',
      }),
    ).resolves.toBeTruthy();
  });

  it('deduplicates on the delivery identifier', async () => {
    // Providers retry, and a retried delivery must not be counted twice.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId, { provider: 'woocommerce' });

    const delivery = {
      businessId,
      connectionId,
      topic: 'order.updated',
      externalDeliveryId: 'delivery-1',
      signatureVerified: true,
    };

    await harness.db.insert(webhookDeliveries).values(delivery);

    expect(await refuses(() => harness.db.insert(webhookDeliveries).values(delivery))).toContain(
      'webhook_deliveries_delivery_unique',
    );
  });

  it('does not treat two deliveries without identifiers as duplicates', async () => {
    // Not every provider sends one, and collapsing them would drop real events.
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId, { provider: 'woocommerce' });

    const delivery = {
      businessId,
      connectionId,
      topic: 'order.updated',
      signatureVerified: true,
    };

    await harness.db.insert(webhookDeliveries).values(delivery);
    await expect(harness.db.insert(webhookDeliveries).values(delivery)).resolves.toBeTruthy();
  });
});

describe('quotas', () => {
  it('accepts an application-level window with no business or connection', async () => {
    // Some eBay limits are per application and belong to no business in the
    // installation. Forcing one to own them would make the numbers wrong.
    await expect(
      harness.db.insert(providerQuotaWindows).values({
        provider: 'ebay',
        apiFamily: 'sell.inventory',
        windowStartsAt: new Date('2026-01-01T00:00:00Z'),
        windowEndsAt: new Date('2026-01-02T00:00:00Z'),
        limitCount: 5000,
        usedCount: 12,
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses a window that names a business but no connection', async () => {
    const { businessId } = await seedBusiness();

    const reason = await refuses(() =>
      harness.db.insert(providerQuotaWindows).values({
        businessId,
        provider: 'ebay',
        apiFamily: 'sell.inventory',
        windowStartsAt: new Date('2026-02-01T00:00:00Z'),
        windowEndsAt: new Date('2026-02-02T00:00:00Z'),
      }),
    );

    expect(reason).toContain('provider_quota_windows_scope_consistent');
  });

  it('refuses a window that ends before it starts', async () => {
    const reason = await refuses(() =>
      harness.db.insert(providerQuotaWindows).values({
        provider: 'woocommerce',
        apiFamily: 'wc.products',
        windowStartsAt: new Date('2026-03-02T00:00:00Z'),
        windowEndsAt: new Date('2026-03-01T00:00:00Z'),
      }),
    );

    expect(reason).toContain('provider_quota_windows_window_ordered');
  });
});

describe('health', () => {
  it('keeps one health row per connection and removes it with the connection', async () => {
    const { businessId } = await seedBusiness();
    const connectionId = await seedConnection(businessId);

    await harness.db
      .insert(connectionHealth)
      .values({ businessId, connectionId, status: 'healthy', checkedAt: new Date() });

    expect(
      await refuses(() =>
        harness.db
          .insert(connectionHealth)
          .values({ businessId, connectionId, status: 'degraded' }),
      ),
    ).toContain('connection_health_pkey');

    await harness.db.delete(connections).where(eq(connections.id, connectionId));

    const remaining = await harness.db
      .select({ connectionId: connectionHealth.connectionId })
      .from(connectionHealth)
      .where(eq(connectionHealth.connectionId, connectionId));

    expect(remaining).toEqual([]);
  });
});
