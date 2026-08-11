import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import type { Subject } from '@eim/authz';
import { loadKeyring } from '@eim/crypto';
import { aiProviderSecrets, aiProviders, businesses, users } from '@eim/db';
import { FakeAiAdapter, type UrlPolicy } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AiConfigurationError,
  configureProvider,
  loadProvider,
  removeProvider,
  setProviderEnabled,
  testProvider,
  usableProvider,
} from './providers';
import { createAiSecretStore, type AiSecretStore } from './credentials';

/**
 * Configuring an endpoint, and the custody of its key (sections 18, 19, 20).
 *
 * The claims worth proving are the ones section 18 opens with and section 36
 * asks for by name: that the feature arrives off, that it cannot be switched on
 * against an endpoint nobody has reached, and that a key is encrypted, bound to
 * its row, and destroyed when the configuration goes.
 */

let harness: TestDatabase;
let secrets: AiSecretStore;

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createAiSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 9).toString('base64') }]),
      activeVersion: 1,
    }),
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

interface Fixture {
  readonly businessId: string;
  readonly userId: string;
  readonly audit: AuditRecorder;
  readonly subject: Subject;
}

async function seed(): Promise<Fixture> {
  const slug = `aicfg-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Owner' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const userId = user!.id;

  return {
    businessId,
    userId,
    audit: createAuditRecorder({ actor: { kind: 'user', userId }, businessId }),
    subject: {
      userId,
      isOwner: false,
      grants: [{ permission: 'manage_ai', scope: { kind: 'business' } }],
    },
  };
}

/** A public endpoint is permitted; nothing private is, unless a test says so. */
const publicOnly: UrlPolicy = { allowInsecure: false, allowPrivate: false, allowlist: [] };

const selfHosted: UrlPolicy = { allowInsecure: true, allowPrivate: true, allowlist: [] };

function configure(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return configureProvider(harness.db, secrets, fixture.audit, {
    businessId: fixture.businessId,
    kind: 'openai_compatible',
    baseUrl: 'https://models.example.invalid/v1',
    model: 'a-model',
    subject: fixture.subject,
    actorUserId: fixture.userId,
    hasRecentAuthentication: true,
    urlPolicy: publicOnly,
    ...overrides,
  } as never);
}

const adapterFor = (adapter: FakeAiAdapter) => () => Promise.resolve(adapter);

describe('configuring', () => {
  it('stores an endpoint that is off and unchecked', async () => {
    const fixture = await seed();

    const provider = await configure(fixture);

    expect(provider.enabled).toBe(false);
    expect(provider.status).toBe('unchecked');
    expect(await usableProvider(harness.db, fixture.businessId)).toBeNull();
  });

  it('refuses somebody without manage_ai', async () => {
    const fixture = await seed();

    await expect(
      configure(fixture, { subject: { ...fixture.subject, grants: [] } }),
    ).rejects.toMatchObject({ reason: 'not_permitted' });
  });

  it('refuses a session that authenticated too long ago', async () => {
    const fixture = await seed();

    await expect(configure(fixture, { hasRecentAuthentication: false })).rejects.toMatchObject({
      reason: 'recent_authentication_required',
    });
  });

  it('refuses a private address unless the installation allows one', async () => {
    const fixture = await seed();

    await expect(
      configure(fixture, { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }),
    ).rejects.toMatchObject({ reason: 'destination_refused' });
  });

  it('accepts a local Ollama when the installation has opted in', async () => {
    const fixture = await seed();

    const provider = await configure(fixture, {
      kind: 'ollama',
      baseUrl: 'http://ollama.internal:11434',
      urlPolicy: selfHosted,
    });

    expect(provider.kind).toBe('ollama');
    // Stored canonical, which for a bare origin keeps the root slash `URL`
    // produces. What matters is that two spellings of one endpoint store the
    // same string, not which of them wins.
    expect(provider.baseUrl).toBe('http://ollama.internal:11434/');
  });

  it('refuses an address with a credential in it', async () => {
    const fixture = await seed();

    await expect(
      configure(fixture, { baseUrl: 'https://key:secret@models.example.invalid/v1' }),
    ).rejects.toMatchObject({ reason: 'destination_refused' });
  });

  it('edits the one configuration rather than adding a second', async () => {
    const fixture = await seed();
    const first = await configure(fixture);
    const second = await configure(fixture, { model: 'another-model' });

    expect(second.id).toBe(first.id);
    expect(second.model).toBe('another-model');
  });

  it('records the address in the trail and never the key', async () => {
    const fixture = await seed();
    await configure(fixture, { apiKey: 'sk-super-secret-value' });

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId);
    const configured = events.find((event) => event.action === 'ai.provider.configured');

    expect(configured).toBeDefined();
    expect(JSON.stringify(configured?.detail)).toContain('models.example.invalid');
    expect(JSON.stringify(configured?.detail)).not.toContain('sk-super-secret-value');
  });
});

describe('the credential', () => {
  it('is stored encrypted and read back through the store', async () => {
    const fixture = await seed();
    const provider = await configure(fixture, { apiKey: 'sk-first' });

    const [row] = await harness.db
      .select()
      .from(aiProviderSecrets)
      .where(eq(aiProviderSecrets.providerId, provider.id));

    expect(row?.ciphertext).not.toContain('sk-first');
    expect(await secrets.read({ businessId: fixture.businessId, providerId: provider.id })).toBe(
      'sk-first',
    );
  });

  it('rotates without ever leaving the configuration keyless', async () => {
    const fixture = await seed();
    const provider = await configure(fixture, { apiKey: 'sk-first' });
    await configure(fixture, { apiKey: 'sk-second' });

    const live = await harness.db
      .select()
      .from(aiProviderSecrets)
      .where(
        and(eq(aiProviderSecrets.providerId, provider.id), isNull(aiProviderSecrets.retiredAt)),
      );

    expect(live).toHaveLength(1);
    expect(await secrets.read({ businessId: fixture.businessId, providerId: provider.id })).toBe(
      'sk-second',
    );
  });

  it('is nothing at all for a local endpoint that needs none', async () => {
    const fixture = await seed();
    const provider = await configure(fixture, {
      kind: 'ollama',
      baseUrl: 'http://ollama.internal:11434',
      urlPolicy: selfHosted,
    });

    expect(
      await secrets.read({ businessId: fixture.businessId, providerId: provider.id }),
    ).toBeNull();
  });

  it('will not decrypt for a different configuration', async () => {
    const one = await seed();
    const two = await seed();
    const provider = await configure(one, { apiKey: 'sk-one' });
    await configure(two, { apiKey: 'sk-two' });

    await expect(
      secrets.read({ businessId: two.businessId, providerId: provider.id }),
    ).resolves.toBeNull();
  });
});

describe('testing and enabling', () => {
  it('will not enable an endpoint that has never answered', async () => {
    const fixture = await seed();
    await configure(fixture);

    await expect(
      setProviderEnabled(harness.db, fixture.audit, {
        businessId: fixture.businessId,
        enabled: true,
        subject: fixture.subject,
      }),
    ).rejects.toMatchObject({ reason: 'never_answered' });
  });

  it('marks an endpoint ready once it answers, and only then can it be enabled', async () => {
    const fixture = await seed();
    await configure(fixture);

    const result = await testProvider(harness.db, fixture.audit, adapterFor(new FakeAiAdapter()), {
      businessId: fixture.businessId,
      subject: fixture.subject,
      urlPolicy: publicOnly,
    });

    expect(result.ready).toBe(true);

    await setProviderEnabled(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      enabled: true,
      subject: fixture.subject,
    });

    expect(await usableProvider(harness.db, fixture.businessId)).not.toBeNull();
  });

  it('switches a failing endpoint off rather than leaving it available', async () => {
    const fixture = await seed();
    await configure(fixture);
    await testProvider(harness.db, fixture.audit, adapterFor(new FakeAiAdapter()), {
      businessId: fixture.businessId,
      subject: fixture.subject,
      urlPolicy: publicOnly,
    });
    await setProviderEnabled(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      enabled: true,
      subject: fixture.subject,
    });

    const failing = new FakeAiAdapter({
      failures: [{ status: 'unauthorized', requiresReauthorization: false, message: 'bad key' }],
    });
    const result = await testProvider(harness.db, fixture.audit, adapterFor(failing), {
      businessId: fixture.businessId,
      subject: fixture.subject,
      urlPolicy: publicOnly,
    });

    expect(result.ready).toBe(false);
    expect(await usableProvider(harness.db, fixture.businessId)).toBeNull();
  });

  it('refuses a stored address that the policy no longer permits', async () => {
    const fixture = await seed();
    await configure(fixture, {
      kind: 'ollama',
      baseUrl: 'http://ollama.internal:11434',
      urlPolicy: selfHosted,
    });

    // The installation has since withdrawn its private-host exception. The
    // address has not changed; what may be reached has.
    const result = await testProvider(harness.db, fixture.audit, adapterFor(new FakeAiAdapter()), {
      businessId: fixture.businessId,
      subject: fixture.subject,
      urlPolicy: publicOnly,
    });

    expect(result.ready).toBe(false);
    expect(result.summary).toContain('no longer permitted');
  });

  it('un-readies an endpoint when its address or model is edited', async () => {
    const fixture = await seed();
    await configure(fixture);
    await testProvider(harness.db, fixture.audit, adapterFor(new FakeAiAdapter()), {
      businessId: fixture.businessId,
      subject: fixture.subject,
      urlPolicy: publicOnly,
    });

    const edited = await configure(fixture, { model: 'a-different-model' });

    expect(edited.status).toBe('unchecked');
  });

  it('always allows switching off', async () => {
    const fixture = await seed();
    await configure(fixture);

    const provider = await setProviderEnabled(harness.db, fixture.audit, {
      businessId: fixture.businessId,
      enabled: false,
      subject: fixture.subject,
    });

    expect(provider.enabled).toBe(false);
  });
});

describe('removing', () => {
  it('destroys the key and the configuration', async () => {
    const fixture = await seed();
    const provider = await configure(fixture, { apiKey: 'sk-gone' });

    await removeProvider(harness.db, secrets, fixture.audit, {
      businessId: fixture.businessId,
      subject: fixture.subject,
    });

    expect(await loadProvider(harness.db, fixture.businessId)).toBeNull();
    expect(
      await secrets.read({ businessId: fixture.businessId, providerId: provider.id }),
    ).toBeNull();
    expect(
      await harness.db.select().from(aiProviders).where(eq(aiProviders.id, provider.id)),
    ).toEqual([]);
  });

  it('refuses when there is nothing configured', async () => {
    const fixture = await seed();

    await expect(
      removeProvider(harness.db, secrets, fixture.audit, {
        businessId: fixture.businessId,
        subject: fixture.subject,
      }),
    ).rejects.toBeInstanceOf(AiConfigurationError);
  });
});
