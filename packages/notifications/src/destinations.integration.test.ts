import { loadKeyring } from '@eim/crypto';
import { alertDestinations, businesses } from '@eim/db';
import type { UrlPolicy } from '@eim/providers';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  configureDestination,
  createDestinationSecretStore,
  destinationWants,
  listDestinations,
  markDestinationFailing,
  markDestinationReady,
  removeDestination,
  setDestinationEnabled,
  type DestinationSecretStore,
} from './destinations';

/**
 * Where a business sends its alerts (sections 19, 22).
 *
 * Two things are worth proving. The URL never appears in the open, because it
 * is a bearer credential and a row somebody can read is a channel somebody can
 * post into. And a destination cannot be switched on until it has answered,
 * because the alternative is discovering it was wrong on the night it mattered.
 */

let harness: TestDatabase;
let secrets: DestinationSecretStore;

const POLICY: UrlPolicy = { allowPrivate: false, allowInsecure: false, allowlist: [] };

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createDestinationSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 7).toString('base64') }]),
      activeVersion: 1,
    }),
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(): Promise<string> {
  const slug = `dest-${String((counter += 1))}`;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });

  return business!.id;
}

describe('configureDestination', () => {
  it('keeps the URL out of the open and the host in it', async () => {
    const businessId = await seed();

    const outcome = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'slack',
      label: 'the warehouse channel',
      url: 'https://hooks.slack.example/services/T000/B000/XXXXXXXXXXXX',
    });

    expect(outcome.ok).toBe(true);
    const [row] = await listDestinations(harness.db, businessId);

    expect(row?.endpointHost).toBe('hooks.slack.example');
    // The credential-bearing part is nowhere on the row.
    expect(JSON.stringify(row)).not.toContain('XXXXXXXXXXXX');

    expect(
      await secrets.read({
        businessId,
        destinationId: row!.id,
        secretType: 'endpoint_url',
      }),
    ).toContain('XXXXXXXXXXXX');
  });

  it('refuses an address the SSRF policy refuses', async () => {
    const businessId = await seed();

    const outcome = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'webhook',
      label: 'the metadata service',
      url: 'http://169.254.169.254/latest/meta-data/',
    });

    expect(outcome.ok).toBe(false);
    expect(await listDestinations(harness.db, businessId)).toHaveLength(0);
  });

  it('gives a generic webhook a signing key, once', async () => {
    const businessId = await seed();

    const created = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'webhook',
      label: 'our own receiver',
      url: 'https://receiver.example/alerts',
    });

    expect(created.ok && created.signingKey).toBeTruthy();

    // Editing does not invalidate a receiver's configuration, so no new key.
    const edited = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      destinationId: created.ok ? created.destinationId : '',
      kind: 'webhook',
      label: 'our own receiver, renamed',
      url: 'https://receiver.example/alerts',
    });

    expect(edited.ok && edited.signingKey).toBeNull();
  });

  it('gives a chat webhook no signing key, because it signs nothing', async () => {
    const businessId = await seed();

    const created = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'discord',
      label: 'ops',
      url: 'https://discord.example/api/webhooks/1/abc',
    });

    expect(created.ok && created.signingKey).toBeNull();
  });

  it('makes an edited destination unproven again', async () => {
    const businessId = await seed();
    const created = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'slack',
      label: 'ops',
      url: 'https://hooks.slack.example/services/A/B/C',
    });
    const destinationId = created.ok ? created.destinationId : '';

    await markDestinationReady(harness.db, businessId, destinationId);
    await setDestinationEnabled(harness.db, businessId, destinationId, true);

    await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      destinationId,
      kind: 'slack',
      label: 'ops',
      url: 'https://hooks.slack.example/services/D/E/F',
    });

    const [row] = await listDestinations(harness.db, businessId);
    expect(row?.status).toBe('unchecked');
    expect(row?.enabled).toBe(false);
  });

  it('refuses to edit a destination belonging to somebody else', async () => {
    const mine = await seed();
    const theirs = await seed();
    const created = await configureDestination(harness.db, secrets, POLICY, {
      businessId: mine,
      kind: 'slack',
      label: 'ops',
      url: 'https://hooks.slack.example/services/A/B/C',
    });

    const outcome = await configureDestination(harness.db, secrets, POLICY, {
      businessId: theirs,
      destinationId: created.ok ? created.destinationId : '',
      kind: 'slack',
      label: 'stolen',
      url: 'https://hooks.slack.example/services/X/Y/Z',
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('the three switches', () => {
  it('will not switch on something that has never answered', async () => {
    const businessId = await seed();
    const created = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'slack',
      label: 'ops',
      url: 'https://hooks.slack.example/services/A/B/C',
    });
    const destinationId = created.ok ? created.destinationId : '';

    const refused = await setDestinationEnabled(harness.db, businessId, destinationId, true);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('test');

    await markDestinationReady(harness.db, businessId, destinationId);
    expect((await setDestinationEnabled(harness.db, businessId, destinationId, true)).ok).toBe(
      true,
    );
  });

  it('is refused by the database too, not only by the code', async () => {
    const businessId = await seed();
    await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'slack',
      label: 'ops',
      url: 'https://hooks.slack.example/services/A/B/C',
    });
    const [row] = await listDestinations(harness.db, businessId);

    expect(
      await refuses(() =>
        harness.db
          .update(alertDestinations)
          .set({ enabled: true })
          .where(eq(alertDestinations.id, row!.id)),
      ),
    ).toMatch(/alert_destinations_enabled_means_checked/u);
  });

  it('switches a broken destination off rather than queueing behind it', async () => {
    const businessId = await seed();
    const created = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'slack',
      label: 'ops',
      url: 'https://hooks.slack.example/services/A/B/C',
    });
    const destinationId = created.ok ? created.destinationId : '';

    await markDestinationReady(harness.db, businessId, destinationId);
    await setDestinationEnabled(harness.db, businessId, destinationId, true);
    await markDestinationFailing(harness.db, businessId, destinationId, 'the channel was archived');

    const [row] = await listDestinations(harness.db, businessId);
    expect(row?.enabled).toBe(false);
    expect(row?.status).toBe('failing');
    expect(row?.statusReason).toBe('the channel was archived');
  });

  it('switching off is never refused', async () => {
    const businessId = await seed();
    const created = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'slack',
      label: 'ops',
      url: 'https://hooks.slack.example/services/A/B/C',
    });
    const destinationId = created.ok ? created.destinationId : '';

    expect((await setDestinationEnabled(harness.db, businessId, destinationId, false)).ok).toBe(
      true,
    );
  });

  it('removes a destination and its credential together', async () => {
    const businessId = await seed();
    const created = await configureDestination(harness.db, secrets, POLICY, {
      businessId,
      kind: 'webhook',
      label: 'ours',
      url: 'https://receiver.example/alerts',
    });
    const destinationId = created.ok ? created.destinationId : '';

    expect(await removeDestination(harness.db, businessId, destinationId)).toBe(true);
    expect(
      await secrets.read({ businessId, destinationId, secretType: 'endpoint_url' }),
    ).toBeNull();
  });
});

describe('destinationWants', () => {
  const ready = {
    enabled: true,
    status: 'ready' as const,
    minSeverity: 'error' as const,
    eventAllowlist: [] as string[],
  };

  it('takes everything when the allowlist is empty', () => {
    expect(destinationWants(ready, { kind: 'oversold', severity: 'critical' })).toBe(true);
  });

  it('takes nothing below its floor', () => {
    expect(destinationWants(ready, { kind: 'oversold', severity: 'warning' })).toBe(false);
  });

  it('narrows to the listed kinds when a list is given', () => {
    const narrowed = { ...ready, eventAllowlist: ['oversold'] };

    expect(destinationWants(narrowed, { kind: 'oversold', severity: 'critical' })).toBe(true);
    expect(destinationWants(narrowed, { kind: 'queue_stalled', severity: 'critical' })).toBe(false);
  });

  it('takes nothing at all when it is off or unproven', () => {
    expect(
      destinationWants({ ...ready, enabled: false }, { kind: 'oversold', severity: 'critical' }),
    ).toBe(false);
    expect(
      destinationWants({ ...ready, status: 'failing' }, { kind: 'oversold', severity: 'critical' }),
    ).toBe(false);
  });
});
