import { businesses, connectionScopes, connections, memberships, users } from '@eim/db';
import type { HttpClient, HttpOutcome } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEbayReadiness, type EbayReadiness } from './readiness';

/**
 * What a connection can and cannot do yet (section 13).
 *
 * The assertions that matter are about refusing to overstate. A capability
 * enabled on the strength of a check that could not be performed fails on its
 * first real use, and the first real use of a quantity write is the moment a
 * seller's listing goes to the wrong number.
 *
 * Every check is a GET. One test asserts that directly, because a readiness
 * assessment that fixes what it finds is one that changes a seller's account on
 * a schedule nobody agreed to.
 */

let harness: TestDatabase;

const READ_INVENTORY = 'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly';
const READ_ORDERS = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';
const READ_ACCOUNT = 'https://api.ebay.com/oauth/api_scope/sell.account.readonly';
const IDENTITY = 'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly';
const WRITE_INVENTORY = 'https://api.ebay.com/oauth/api_scope/sell.inventory';

const ALL_READ = [READ_INVENTORY, READ_ORDERS, READ_ACCOUNT, IDENTITY];

/** eBay, answering by path. Anything unstubbed is a request we did not expect. */
class FakeEbay {
  public readonly requests: { method: string; url: string }[] = [];
  private routes = new Map<string, HttpOutcome>();

  reset(): void {
    this.requests.length = 0;
    this.routes.clear();
  }

  on(pathFragment: string, outcome: HttpOutcome): this {
    this.routes.set(pathFragment, outcome);

    return this;
  }

  readonly client: HttpClient = {
    send: (request) => {
      this.requests.push({ method: request.method, url: request.url });

      for (const [fragment, outcome] of this.routes) {
        if (request.url.includes(fragment)) {
          return Promise.resolve(outcome);
        }
      }

      return Promise.resolve({ ok: false, kind: 'transport', reason: 'ECONNREFUSED' });
    },
  };
}

const ebay = new FakeEbay();

const body = (payload: unknown, status = 200): HttpOutcome => ({
  ok: true,
  response: {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    url: 'https://api.ebay.com/',
  },
});

/** The account eBay describes when everything is set up properly. */
function healthyAccount(): void {
  ebay
    .on(
      '/sell/account/v1/privilege',
      body({ sellerRegistrationCompleted: true, outOfStockControlEnabled: true }),
    )
    .on('payment_policy', body({ paymentPolicies: [{ paymentPolicyId: '1' }] }))
    .on('return_policy', body({ returnPolicies: [{ returnPolicyId: '2' }] }))
    .on('fulfillment_policy', body({ fulfillmentPolicies: [{ fulfillmentPolicyId: '3' }] }))
    .on(
      '/sell/inventory/v1/location',
      body({
        locations: [{ merchantLocationKey: 'WAREHOUSE', merchantLocationStatus: 'ENABLED' }],
      }),
    );
}

function readinessWith(token: string | null): EbayReadiness {
  return createEbayReadiness({
    db: harness.db,
    http: ebay.client,
    accessToken: () => Promise.resolve(token),
  });
}

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(() => {
  ebay.reset();
});

let counter = 0;

async function seedConnection(
  scopes: readonly string[] = ALL_READ,
  status: 'active' | 'paused' | 'disconnected' = 'active',
): Promise<{ businessId: string; connectionId: string }> {
  const slug = `ready-${String((counter += 1))}`;

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
      status,
      connectedAt: new Date(),
      ...(status === 'paused' ? { pauseReason: 'paused for the test' } : {}),
      ...(status === 'disconnected' ? { disconnectedAt: new Date() } : {}),
    })
    .returning({ id: connections.id });

  if (scopes.length > 0) {
    await harness.db.insert(connectionScopes).values(
      scopes.map((scope) => ({
        businessId: business!.id,
        connectionId: connection!.id,
        scope,
      })),
    );
  }

  return { businessId: business!.id, connectionId: connection!.id };
}

const statusOf = (report: { checks: readonly { name: string; status: string }[] }, name: string) =>
  report.checks.find((check) => check.name === name)?.status;

describe('a properly set up account', () => {
  it('passes every check and enables the read capabilities', async () => {
    healthyAccount();

    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    for (const check of report.checks) {
      expect(check.status, check.name).toBe('pass');
    }

    expect(report.available).toContain('import_catalog');
    expect(report.available).toContain('import_orders');
    expect(report.available).toContain('import_policies');
  });

  it('still blocks writing, because M2 was not granted the scope for it', async () => {
    healthyAccount();

    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    expect(report.blocked).toContainEqual({ capability: 'write_quantities', because: 'scopes' });
  });

  it('enables writing once the write scope is present and the account allows it', async () => {
    healthyAccount();

    const connection = await seedConnection([...ALL_READ, WRITE_INVENTORY]);
    const report = await readinessWith('token').assess(connection);

    expect(report.available).toContain('write_quantities');
  });

  it('only ever reads', async () => {
    // A readiness check that fixes what it finds changes a seller's account on
    // a schedule nobody agreed to. Section 13 is explicit: detect and warn.
    healthyAccount();

    const connection = await seedConnection();
    await readinessWith('token').assess(connection);

    expect(ebay.requests.length).toBeGreaterThan(0);

    for (const request of ebay.requests) {
      expect(request.method).toBe('GET');
    }
  });
});

describe('an account that needs setting up', () => {
  it('warns about missing business policies without blocking the catalog import', async () => {
    // Version 1 imports and selects policies; it does not create them. An
    // account with none is a setup task, and one that stops publication rather
    // than everything.
    healthyAccount();
    ebay.on('payment_policy', body({ paymentPolicies: [] }));

    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    expect(statusOf(report, 'business_policies')).toBe('warn');
    expect(report.available).toContain('import_catalog');
  });

  it('fails on no inventory location, because a quantity has to go somewhere', async () => {
    healthyAccount();
    ebay.on('/sell/inventory/v1/location', body({ locations: [] }));

    const connection = await seedConnection([...ALL_READ, WRITE_INVENTORY]);
    const report = await readinessWith('token').assess(connection);

    expect(statusOf(report, 'inventory_locations')).toBe('fail');
    expect(report.blocked).toContainEqual({
      capability: 'write_quantities',
      because: 'inventory_locations',
    });
    // And the import is unaffected: reading a catalog needs no location.
    expect(report.available).toContain('import_catalog');
  });

  it('does not count a disabled location as one', async () => {
    healthyAccount();
    ebay.on(
      '/sell/inventory/v1/location',
      body({ locations: [{ merchantLocationKey: 'OLD', merchantLocationStatus: 'DISABLED' }] }),
    );

    const connection = await seedConnection([...ALL_READ, WRITE_INVENTORY]);
    const report = await readinessWith('token').assess(connection);

    expect(statusOf(report, 'inventory_locations')).toBe('fail');
  });

  it('warns when out-of-stock control is off, and says what that costs', async () => {
    // With it off, a listing that reaches zero ends and has to be relisted,
    // which loses its identifiers and every mapping pointing at them.
    healthyAccount();
    ebay.on(
      '/sell/account/v1/privilege',
      body({ sellerRegistrationCompleted: true, outOfStockControlEnabled: false }),
    );

    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    const check = report.checks.find((entry) => entry.name === 'out_of_stock_control');

    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('mappings');
  });

  it('warns when the seller registration is incomplete', async () => {
    healthyAccount();
    ebay.on(
      '/sell/account/v1/privilege',
      body({ sellerRegistrationCompleted: false, outOfStockControlEnabled: true }),
    );

    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    expect(statusOf(report, 'marketplace')).toBe('warn');
  });
});

describe('when eBay does not answer', () => {
  it('reports unknown rather than pass', async () => {
    // "eBay says there are no policies" and "eBay did not answer" send an
    // operator to fix different things.
    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    expect(statusOf(report, 'inventory_locations')).toBe('unknown');
    expect(statusOf(report, 'business_policies')).toBe('unknown');
    expect(statusOf(report, 'api_reachable')).toBe('fail');
  });

  it('blocks every capability that depended on the check it could not run', async () => {
    // A capability enabled on the strength of an unperformed check fails on its
    // first real use.
    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    expect(report.available).toEqual([]);
    expect(report.blocked.map((entry) => entry.capability)).toContain('import_catalog');
  });

  it('reports partial unreachability as a warning', async () => {
    healthyAccount();
    ebay.on('/sell/inventory/v1/location', { ok: false, kind: 'timeout', reason: 'timed out' });

    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    expect(statusOf(report, 'api_reachable')).toBe('warn');
  });

  it('treats an unparseable body as unknown, not as an empty account', async () => {
    // A proxy error page with a 200 would otherwise read as "you have no
    // locations", which is a very different instruction.
    healthyAccount();
    ebay.on('/sell/inventory/v1/location', {
      ok: true,
      response: {
        status: 200,
        headers: {},
        body: '<html>Gateway Timeout</html>',
        url: 'https://api.ebay.com/',
      },
    });

    const connection = await seedConnection();
    const report = await readinessWith('token').assess(connection);

    expect(statusOf(report, 'inventory_locations')).toBe('unknown');
  });
});

describe('when the credentials are gone', () => {
  it('points at the credentials rather than at eight symptoms of them', async () => {
    const connection = await seedConnection();
    const report = await readinessWith(null).assess(connection);

    expect(statusOf(report, 'api_reachable')).toBe('unknown');
    expect(report.checks.find((check) => check.name === 'api_reachable')?.summary).toContain(
      'reauthoriz',
    );
    // Nothing was even attempted.
    expect(ebay.requests).toEqual([]);
  });

  it('fails the identity check for a disconnected connection', async () => {
    const connection = await seedConnection(ALL_READ, 'disconnected');
    const report = await readinessWith(null).assess(connection);

    expect(statusOf(report, 'identity')).toBe('fail');
    expect(report.available).toEqual([]);
  });

  it('warns rather than fails for a paused connection', async () => {
    // Paused is recoverable and usually deliberate; the operator does not need
    // to be told their connection is broken.
    const connection = await seedConnection(ALL_READ, 'paused');
    const report = await readinessWith(null).assess(connection);

    expect(statusOf(report, 'identity')).toBe('warn');
  });

  it('fails the scope check when eBay granted nothing', async () => {
    const connection = await seedConnection([]);
    const report = await readinessWith(null).assess(connection);

    expect(statusOf(report, 'scopes')).toBe('fail');
  });
});

describe('persistence', () => {
  it('records the outcome so a screen can render it without calling eBay', async () => {
    healthyAccount();

    const connection = await seedConnection();
    await readinessWith('token').assess(connection);

    ebay.reset();

    const stored = await readinessWith('token').read(connection);

    expect(stored?.checks.length).toBeGreaterThan(0);
    expect(stored?.available).toContain('import_catalog');
    expect(ebay.requests).toEqual([]);
  });

  it('replaces the previous outcome rather than merging with it', async () => {
    // A check that stopped being run would otherwise keep its last answer
    // forever, and a stale `pass` is worse than no answer.
    healthyAccount();

    const connection = await seedConnection();
    await readinessWith('token').assess(connection);

    ebay.reset();
    await readinessWith(null).assess(connection);

    const stored = await readinessWith('token').read(connection);

    expect(statusOf(stored!, 'inventory_locations')).toBe('unknown');
  });

  it('has nothing to read before the first assessment', async () => {
    const connection = await seedConnection();

    expect(await readinessWith('token').read(connection)).toBeNull();
  });

  it('does not return another business’s assessment', async () => {
    healthyAccount();

    const connection = await seedConnection();
    const stranger = await seedConnection();

    await readinessWith('token').assess(connection);

    expect(
      await readinessWith('token').read({
        businessId: stranger.businessId,
        connectionId: connection.connectionId,
      }),
    ).toBeNull();
  });

  it('reports a connection that has been deleted rather than throwing', async () => {
    const connection = await seedConnection();

    await harness.db.delete(connections).where(eq(connections.id, connection.connectionId));

    const report = await readinessWith('token').assess(connection);

    expect(statusOf(report, 'identity')).toBe('fail');
    expect(report.available).toEqual([]);
  });
});
