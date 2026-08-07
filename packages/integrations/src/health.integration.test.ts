import { businesses, connectionHealth, connections, providerWebhooks, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createConnectionHealth } from './health';
import { CIRCUIT_COOLDOWN_MS, CIRCUIT_THRESHOLD } from './health-policy';
import { createQuotaLedger, type QuotaLedger } from './quota';

/**
 * Quota accounting and connection health against a real database
 * (sections 12, 13, 14).
 *
 * What needs a real PostgreSQL: the upsert on the quota window's expression
 * index, the in-statement increment that makes two workers count as two calls,
 * and the fact that a health record and a circuit decision cannot disagree
 * because the second is derived from the first.
 */

let harness: TestDatabase;
let quotas: QuotaLedger;

const NOW = new Date('2026-03-01T12:00:00Z');

beforeAll(async () => {
  harness = await createTestDatabase();
  quotas = createQuotaLedger(harness.db);
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

const health = () => createConnectionHealth({ db: harness.db, quotas });

let counter = 0;

async function seedConnection(
  overrides: Partial<typeof connections.$inferInsert> = {},
): Promise<{ businessId: string; connectionId: string }> {
  const slug = `health-${String((counter += 1))}`;

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
      provider: 'ebay',
      environment: 'production',
      externalAccountId: slug,
      displayName: slug,
      status: 'active',
      connectedAt: new Date('2026-01-01T00:00:00Z'),
      activatedAt: new Date('2026-01-01T00:00:00Z'),
      createdByUserId: user!.id,
      ...overrides,
    })
    .returning({ id: connections.id });

  return { businessId: business!.id, connectionId: connection!.id };
}

describe('recording what a provider reported', () => {
  it('keeps one row per window and replaces the count with the provider’s own', async () => {
    // The provider knows about calls this process did not make — another
    // replica's, a previous deployment's — and a local tally that disagreed
    // would be lower, which is the dangerous direction.
    const ref = await seedConnection();
    const window = {
      provider: 'ebay' as const,
      apiFamily: 'sell.inventory',
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      windowStartsAt: NOW,
      windowEndsAt: new Date(NOW.getTime() + 86_400_000),
    };

    await quotas.observe({ ...window, limit: 5000, used: 100, now: NOW });
    const second = await quotas.observe({ ...window, limit: 5000, used: 4900, now: NOW });

    expect(second).toMatchObject({ used: 4900, limit: 5000, pressure: 'critical' });

    const live = await quotas.read({ connectionId: ref.connectionId, now: NOW });

    expect(live).toHaveLength(1);
  });

  it('counts calls for a provider that reports nothing', async () => {
    // WooCommerce has no quota API; what limits a store is its own host.
    const ref = await seedConnection({ provider: 'woocommerce' });
    const call = {
      provider: 'woocommerce' as const,
      apiFamily: 'products',
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      now: NOW,
    };

    await quotas.consume(call);
    await quotas.consume(call);
    const third = await quotas.consume({ ...call, count: 3 });

    expect(third).toMatchObject({ used: 5, limit: null, pressure: 'unknown' });
  });

  it('keeps an application-wide window apart from a connection’s', async () => {
    // eBay's daily application allowance is not any one seller's, and the index
    // has to distinguish them without a connection identifier to key on.
    const ref = await seedConnection();

    await quotas.observe({
      provider: 'ebay',
      apiFamily: 'notification',
      limit: 1000,
      used: 10,
      windowStartsAt: NOW,
      windowEndsAt: new Date(NOW.getTime() + 86_400_000),
      now: NOW,
    });

    await quotas.observe({
      provider: 'ebay',
      apiFamily: 'notification',
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      limit: 200,
      used: 190,
      windowStartsAt: NOW,
      windowEndsAt: new Date(NOW.getTime() + 86_400_000),
      now: NOW,
    });

    const application = await quotas.check({
      provider: 'ebay',
      apiFamily: 'notification',
      priority: 'background',
      now: NOW,
    });

    const seller = await quotas.check({
      provider: 'ebay',
      apiFamily: 'notification',
      connectionId: ref.connectionId,
      priority: 'background',
      now: NOW,
    });

    expect(application.allowed).toBe(true);
    expect(seller.allowed).toBe(false);
  });

  it('lets a window that has ended stop constraining anything', async () => {
    const ref = await seedConnection();

    await quotas.observe({
      provider: 'ebay',
      apiFamily: 'sell.account',
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      limit: 100,
      used: 100,
      windowStartsAt: new Date(NOW.getTime() - 7200_000),
      windowEndsAt: new Date(NOW.getTime() - 3600_000),
      now: NOW,
    });

    await expect(
      quotas.check({
        provider: 'ebay',
        apiFamily: 'sell.account',
        connectionId: ref.connectionId,
        priority: 'background',
        now: NOW,
      }),
    ).resolves.toMatchObject({ allowed: true, pressure: 'unknown' });
  });

  it('lets the tightest of several live windows decide', async () => {
    const ref = await seedConnection();

    for (const [family, limit, used, span] of [
      ['sell.inventory.daily', 5000, 100, 86_400_000],
      ['sell.inventory.hourly', 100, 95, 3_600_000],
    ] as const) {
      await quotas.observe({
        provider: 'ebay',
        apiFamily: family,
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        limit,
        used,
        windowStartsAt: NOW,
        windowEndsAt: new Date(NOW.getTime() + span),
        now: NOW,
      });
    }

    const live = await quotas.read({ connectionId: ref.connectionId, now: NOW });

    expect(live.map((state) => state.pressure).sort()).toEqual(['critical', 'normal']);
  });
});

describe('the circuit', () => {
  it('opens after enough consecutive failures and closes on one success', async () => {
    // A circuit that only decayed would stay open through a recovery, and the
    // thing it guards against is a provider that is down — which, when it
    // answers, is not down.
    const ref = await seedConnection();
    const service = health();

    for (let attempt = 0; attempt < CIRCUIT_THRESHOLD; attempt += 1) {
      await service.record({ ...ref, outcome: 'failure', summary: 'timed out', now: NOW });
    }

    await expect(service.circuit({ ...ref, now: NOW })).resolves.toMatchObject({
      state: 'open',
      allowed: false,
    });

    await service.record({ ...ref, outcome: 'success', now: NOW });

    await expect(service.circuit({ ...ref, now: NOW })).resolves.toMatchObject({
      state: 'closed',
      allowed: true,
    });
  });

  it('half-opens after the cooldown and lets the next call through', async () => {
    const ref = await seedConnection();
    const service = health();

    for (let attempt = 0; attempt < CIRCUIT_THRESHOLD; attempt += 1) {
      await service.record({ ...ref, outcome: 'failure', now: NOW });
    }

    await expect(
      service.circuit({ ...ref, now: new Date(NOW.getTime() + CIRCUIT_COOLDOWN_MS) }),
    ).resolves.toMatchObject({ state: 'half_open', allowed: true });
  });

  it('says when an open circuit will next try', async () => {
    const ref = await seedConnection();
    const service = health();

    for (let attempt = 0; attempt < CIRCUIT_THRESHOLD; attempt += 1) {
      await service.record({ ...ref, outcome: 'failure', now: NOW });
    }

    const verdict = await service.circuit({ ...ref, now: NOW });

    expect(verdict.retryAt).toEqual(new Date(NOW.getTime() + CIRCUIT_COOLDOWN_MS));
  });

  it('is closed for a connection nothing has ever been recorded about', async () => {
    const ref = await seedConnection();

    await expect(health().circuit({ ...ref, now: NOW })).resolves.toMatchObject({
      state: 'closed',
      allowed: true,
    });
  });
});

describe('assessing a connection', () => {
  it('reports a working connection as healthy and records it', async () => {
    const ref = await seedConnection();
    const service = health();

    await service.record({ ...ref, outcome: 'success', now: NOW });

    const report = await service.assess({ ...ref, now: NOW });

    expect(report).toMatchObject({ status: 'healthy', circuit: 'closed' });

    const [row] = await harness.db
      .select()
      .from(connectionHealth)
      .where(eq(connectionHealth.connectionId, ref.connectionId));

    expect(row?.status).toBe('healthy');
  });

  it('reports unregistered webhook topics as degraded', async () => {
    // Section 14: missing webhook capability produces a visible degraded status
    // rather than silent polling.
    const ref = await seedConnection({ provider: 'woocommerce' });

    await harness.db.insert(providerWebhooks).values([
      {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        topic: 'product.updated',
        deliveryUrl: 'https://inventory.example.invalid/hook',
        status: 'failed',
      },
      {
        businessId: ref.businessId,
        connectionId: ref.connectionId,
        topic: 'order.created',
        externalId: '7',
        deliveryUrl: 'https://inventory.example.invalid/hook',
        status: 'active',
      },
    ]);

    const report = await health().assess({ ...ref, now: NOW });

    expect(report.status).toBe('degraded');
    expect(report.pollingRequired).toEqual(['product.updated']);
    expect(report.summary).toEqual(expect.stringContaining('polling'));
  });

  it('does not call a connection under quota pressure broken', async () => {
    const ref = await seedConnection();

    await quotas.observe({
      provider: 'ebay',
      apiFamily: 'sell.inventory',
      businessId: ref.businessId,
      connectionId: ref.connectionId,
      limit: 1000,
      used: 960,
      windowStartsAt: NOW,
      windowEndsAt: new Date(NOW.getTime() + 86_400_000),
      now: NOW,
    });

    const report = await health().assess({ ...ref, now: NOW });

    expect(report).toMatchObject({ status: 'degraded', quotaPressure: 'critical' });
    expect(report.summary).toEqual(expect.stringContaining('allowance'));
  });

  it('reports a paused connection with the reason it was paused', async () => {
    const ref = await seedConnection({
      status: 'paused',
      pauseReason: 'eBay rejected the stored credentials',
    });

    await expect(health().assess({ ...ref, now: NOW })).resolves.toMatchObject({
      status: 'failing',
      summary: 'eBay rejected the stored credentials',
    });
  });

  it('reports a connection that no longer exists without throwing', async () => {
    await expect(
      health().assess({
        businessId: '00000000-0000-4000-8000-000000000000',
        connectionId: '00000000-0000-4000-8000-000000000001',
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });
  });

  it('does not read another business’s connection', async () => {
    const owner = await seedConnection();
    const stranger = await seedConnection();

    await expect(
      health().assess({
        businessId: stranger.businessId,
        connectionId: owner.connectionId,
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'unknown' });
  });

  it('takes the caller’s word for what needs polling when it is given', async () => {
    // The webhook pass has just asked the store and knows more than the
    // database does.
    const ref = await seedConnection({ provider: 'woocommerce' });

    const report = await health().assess({
      ...ref,
      pollingRequired: ['order.updated'],
      now: NOW,
    });

    expect(report.status).toBe('degraded');
    expect(report.pollingRequired).toEqual(['order.updated']);
  });
});
