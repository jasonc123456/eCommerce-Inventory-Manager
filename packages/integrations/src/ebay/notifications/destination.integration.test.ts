import { createHasher } from '@eim/crypto';
import { notificationDestinations } from '@eim/db';
import type { HttpClient, HttpOutcome, HttpRequest } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CredentialLookup } from '../environment';
import { createDestinations, type Destinations } from './destination';

/**
 * Keeping the notification destination alive.
 *
 * The behaviour worth proving is not the happy path — it is what happens on
 * the second pass and every pass after it. eBay disables a destination that
 * fails to accept deliveries, and an application that trusts its own last
 * write never notices: nothing arrives, nothing errors, and the first symptom
 * is stock that stopped moving days ago.
 */

const TOKEN = 'a'.repeat(40);
const OTHER_TOKEN = 'b'.repeat(40);
const ENDPOINT = 'https://inventory.example.invalid/api/webhooks/ebay';

const credentials: CredentialLookup = (environment) =>
  environment === 'production'
    ? { clientId: 'id', clientSecret: 'secret', ruName: 'RuName' }
    : null;

class FakeEbay {
  public requests: HttpRequest[] = [];
  private routes: { method: string; match: string; outcome: HttpOutcome }[] = [];

  reset(): void {
    this.requests = [];
    this.routes = [];
  }

  on(method: string, match: string, outcome: HttpOutcome): this {
    this.routes.push({ method, match, outcome });

    return this;
  }

  json(method: string, match: string, payload: unknown, status = 200, headers = {}): this {
    return this.on(method, match, {
      ok: true,
      response: { status, headers, body: JSON.stringify(payload), url: 'https://api.ebay.com/' },
    });
  }

  /** Every write, in order, for asserting that a quiet pass stayed quiet. */
  writes(): HttpRequest[] {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  readonly client: HttpClient = {
    send: (request) => {
      this.requests.push(request);

      for (const route of [...this.routes].reverse()) {
        if (route.method === request.method && request.url.includes(route.match)) {
          return Promise.resolve(route.outcome);
        }
      }

      return Promise.resolve({ ok: false, kind: 'transport', reason: 'ECONNREFUSED' });
    },
  };
}

let harness: TestDatabase;
let destinations: Destinations;
const ebay = new FakeEbay();

beforeAll(async () => {
  harness = await createTestDatabase();
  destinations = createDestinations({
    db: harness.db,
    http: ebay.client,
    credentials,
    applicationToken: () => Promise.resolve('app-token'),
    hasher: createHasher('a-test-secret-that-is-long-enough-32'),
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(async () => {
  ebay.reset();
  await harness.db.delete(notificationDestinations);
});

function registered(status = 'ENABLED', endpoint = ENDPOINT) {
  return {
    destinationId: 'dest-1',
    name: 'eCommerce Inventory Manager',
    status,
    deliveryConfig: { endpoint },
  };
}

async function stored() {
  const [row] = await harness.db
    .select()
    .from(notificationDestinations)
    .where(eq(notificationDestinations.environment, 'production'))
    .limit(1);

  return row;
}

describe('createDestinations', () => {
  it('registers a destination when the installation has none', async () => {
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-1' }, 201);

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: true, destinationId: 'dest-1', created: true });
    expect(await stored()).toMatchObject({ externalId: 'dest-1', status: 'enabled' });
  });

  it('reads the identifier from the Location header when the body omits it', async () => {
    // Without the identifier the destination is unmanageable afterwards, so
    // both places eBay has put it are read.
    ebay.json('POST', '/notification/v1/destination', {}, 201, {
      location: 'https://api.ebay.com/commerce/notification/v1/destination/dest-9',
    });

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: true, destinationId: 'dest-9' });
  });

  it('records a registration eBay accepted without naming as failed', async () => {
    // Enabled would be a lie with consequences: a destination that cannot be
    // addressed again cannot be re-enabled when eBay turns it off.
    ebay.json('POST', '/notification/v1/destination', {}, 201);

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'provider_refused' });
    expect(await stored()).toMatchObject({ status: 'failed', externalId: null });
  });

  it('changes nothing on a second pass when eBay agrees with what is recorded', async () => {
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-1' }, 201);
    await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    ebay.reset();
    ebay.json('GET', '/notification/v1/destination/dest-1', registered());

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: true, created: false, updated: false });
    expect(ebay.writes()).toHaveLength(0);
  });

  it('re-enables a destination eBay disabled', async () => {
    // eBay disables a destination after repeated delivery failures. Nothing
    // reports that; it is simply silence, and this is what ends it.
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-1' }, 201);
    await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    ebay.reset();
    ebay.json('GET', '/notification/v1/destination/dest-1', registered('DISABLED'));
    ebay.json('PUT', '/notification/v1/destination/dest-1', {}, 204);

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: true, updated: true, status: 'enabled' });
    expect(ebay.writes().map((request) => request.method)).toEqual(['PUT']);
  });

  it('updates eBay when the public endpoint has moved', async () => {
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-1' }, 201);
    await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    const moved = 'https://inventory.example.invalid/api/webhooks/ebay/v2';

    ebay.reset();
    ebay.json('GET', '/notification/v1/destination/dest-1', registered('ENABLED', ENDPOINT));
    ebay.json('PUT', '/notification/v1/destination/dest-1', {}, 204);

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: moved,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: true, updated: true });
    expect(ebay.writes()[0]?.body).toContain(moved);
    expect(await stored()).toMatchObject({ endpointUrl: moved });
  });

  it('updates eBay when the operator rotated the verification token', async () => {
    // eBay keeps answering challenges with whatever token it was given, so a
    // rotation that is not pushed makes every future challenge fail.
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-1' }, 201);
    await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    ebay.reset();
    ebay.json('GET', '/notification/v1/destination/dest-1', registered());
    ebay.json('PUT', '/notification/v1/destination/dest-1', {}, 204);

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: OTHER_TOKEN,
    });

    expect(outcome).toMatchObject({ ok: true, updated: true });
    expect(ebay.writes()[0]?.body).toContain(OTHER_TOKEN);
  });

  it('never stores the verification token itself', async () => {
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-1' }, 201);
    await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    const row = await stored();

    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(row?.verificationFingerprint).toEqual(expect.any(String));
  });

  it('registers again when eBay has never heard of the recorded destination', async () => {
    // A database restored across keysets, or a destination deleted in the
    // portal. Keeping the dead identifier means never receiving anything again.
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-1' }, 201);
    await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    ebay.reset();
    ebay.json('GET', '/notification/v1/destination/dest-1', {}, 404);
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-2' }, 201);

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: true, destinationId: 'dest-2', created: true });
    expect(await stored()).toMatchObject({ externalId: 'dest-2' });
  });

  it('leaves the recorded state alone when eBay does not answer', async () => {
    // eBay being unreachable says nothing about whether the destination is
    // enabled, and writing a guess is how a working destination comes to look
    // broken on the health surface.
    ebay.json('POST', '/notification/v1/destination', { destinationId: 'dest-1' }, 201);
    await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    ebay.reset();

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'provider_unavailable' });
    expect(await stored()).toMatchObject({ status: 'enabled', externalId: 'dest-1' });
  });

  it('keeps a failed registration retryable when eBay is the problem', async () => {
    ebay.json('POST', '/notification/v1/destination', { error: 'internal' }, 503);

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'provider_unavailable' });
    expect(await stored()).toMatchObject({ status: 'pending' });
  });

  it('records a refusal as failed, with a reason an operator can read', async () => {
    ebay.json('POST', '/notification/v1/destination', { errors: [{ message: 'no' }] }, 400);

    const outcome = await destinations.ensure({
      environment: 'production',
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });

    expect(outcome).toMatchObject({ ok: false, reason: 'provider_refused' });
    expect(await stored()).toMatchObject({
      status: 'failed',
      summary: expect.stringContaining('refused'),
    });
  });

  it('refuses an endpoint eBay could not deliver to, without calling eBay', async () => {
    for (const endpointUrl of [
      'http://inventory.example.invalid/hooks',
      'https://localhost/hooks',
      'https://inventory.local/hooks',
      'https://192.168.1.10/hooks',
      'https://app/hooks',
      'not a url',
    ]) {
      await expect(
        destinations.ensure({ environment: 'production', endpointUrl, verificationToken: TOKEN }),
      ).resolves.toMatchObject({ ok: false, reason: 'endpoint_unusable' });
    }

    expect(ebay.requests).toHaveLength(0);
  });

  it('refuses a verification token of the wrong shape, without calling eBay', async () => {
    for (const verificationToken of ['short', 'a'.repeat(100), `${'a'.repeat(31)} b`]) {
      await expect(
        destinations.ensure({
          environment: 'production',
          endpointUrl: ENDPOINT,
          verificationToken,
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'token_unusable' });
    }

    expect(ebay.requests).toHaveLength(0);
  });

  it('reports an unconfigured environment as unconfigured', async () => {
    await expect(
      destinations.ensure({
        environment: 'sandbox',
        endpointUrl: ENDPOINT,
        verificationToken: TOKEN,
      }),
    ).resolves.toEqual({ ok: false, reason: 'not_configured' });

    expect(ebay.requests).toHaveLength(0);
  });

  it('reports nothing recorded before the first pass', async () => {
    await expect(destinations.read('production')).resolves.toBeNull();
  });
});
