import { createAuditRecorder, readBusinessAuditEvents, type AuditRecorder } from '@eim/audit';
import { loadKeyring } from '@eim/crypto';
import { businesses, shippingAccountSecrets, shippingAccounts, users } from '@eim/db';
import { FakeShippingAdapter } from '@eim/providers';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShippingAccountError, connectAccount, disconnectAccount, testAccount } from './accounts';
import { createShippingSecretStore, type ShippingSecretStore } from './credentials';

/**
 * A business's own postage account, and the custody of its key (sections 2, 19).
 *
 * What is worth proving here is that the key behaves like every other provider
 * credential in this application: encrypted at rest, bound to the row it belongs
 * to, replaced by an overlapping rotation rather than a gap, and destroyed when
 * the account is disconnected while the labels it bought survive.
 */

let harness: TestDatabase;
let secrets: ShippingSecretStore;

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createShippingSecretStore({
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

interface Fixture {
  readonly businessId: string;
  readonly userId: string;
  readonly audit: AuditRecorder;
}

async function seed(): Promise<Fixture> {
  const slug = `acct-${String((counter += 1))}`;

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
  };
}

const adapterFor = (adapter: FakeShippingAdapter) => () => Promise.resolve(adapter);

describe('connecting', () => {
  it('proves the key, records what the provider supports, and never stores it in the clear', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({ capabilities: { supportsVoid: false } });

    const connected = await connectAccount(
      harness.db,
      secrets,
      fixture.audit,
      adapterFor(adapter),
      {
        businessId: fixture.businessId,
        provider: 'easypost',
        environment: 'sandbox',
        displayName: 'Postage',
        apiKey: 'ek_test_supersecret',
        actorUserId: fixture.userId,
      },
    );

    const [row] = await harness.db
      .select()
      .from(shippingAccounts)
      .where(eq(shippingAccounts.id, connected.accountId));

    expect(row?.status).toBe('active');
    // The capability the screen will consult before drawing a void button. It
    // is the provider's answer, not a default.
    expect(row?.capabilities).toMatchObject({ supportsVoid: false });

    const [secret] = await harness.db
      .select()
      .from(shippingAccountSecrets)
      .where(eq(shippingAccountSecrets.accountId, connected.accountId));

    expect(secret?.ciphertext).not.toContain('supersecret');
    expect(
      await secrets.read({ ...fixture, accountId: connected.accountId }, 'easypost_api_key'),
    ).toBe('ek_test_supersecret');
  });

  it('leaves an account pending and says why when the provider rejects the key', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter({
      failures: [{ status: 'unauthorized', requiresReauthorization: true, message: 'bad key' }],
    });

    await expect(
      connectAccount(harness.db, secrets, fixture.audit, adapterFor(adapter), {
        businessId: fixture.businessId,
        provider: 'easypost',
        environment: 'sandbox',
        displayName: 'Postage',
        apiKey: 'wrong',
        actorUserId: fixture.userId,
      }),
    ).rejects.toBeInstanceOf(ShippingAccountError);

    const [row] = await harness.db
      .select()
      .from(shippingAccounts)
      .where(eq(shippingAccounts.businessId, fixture.businessId));

    expect(row?.status).toBe('pending');
    expect(row?.lastFailureSummary).toContain('authorization revoked');
  });

  it('permits one account per provider and environment', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter();

    const connect = async () =>
      connectAccount(harness.db, secrets, fixture.audit, adapterFor(adapter), {
        businessId: fixture.businessId,
        provider: 'easyship',
        environment: 'production',
        displayName: 'Postage',
        apiKey: 'key',
        actorUserId: fixture.userId,
      });

    await connect();
    const message = await refuses(connect);

    expect(message).toContain('shipping_accounts_one_per_provider');
  });
});

describe('the key', () => {
  it('will not decrypt against another account, even with the right keyring', async () => {
    const one = await seed();
    const two = await seed();
    const adapter = new FakeShippingAdapter();

    const first = await connectAccount(harness.db, secrets, one.audit, adapterFor(adapter), {
      businessId: one.businessId,
      provider: 'easypost',
      environment: 'sandbox',
      displayName: 'Postage',
      apiKey: 'ek_one',
      actorUserId: one.userId,
    });
    const second = await connectAccount(harness.db, secrets, two.audit, adapterFor(adapter), {
      businessId: two.businessId,
      provider: 'easypost',
      environment: 'sandbox',
      displayName: 'Postage',
      apiKey: 'ek_two',
      actorUserId: two.userId,
    });

    // Move one business's ciphertext onto the other's row, which is what a bug,
    // a restored backup, or somebody with database access could do.
    const [stolen] = await harness.db
      .select()
      .from(shippingAccountSecrets)
      .where(eq(shippingAccountSecrets.accountId, first.accountId));

    await harness.db
      .update(shippingAccountSecrets)
      .set({ ciphertext: stolen!.ciphertext })
      .where(eq(shippingAccountSecrets.accountId, second.accountId));

    await expect(
      secrets.read({ businessId: two.businessId, accountId: second.accountId }, 'easypost_api_key'),
    ).rejects.toThrow();
  });

  it('rotates without ever leaving the account without one', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter();

    const connected = await connectAccount(
      harness.db,
      secrets,
      fixture.audit,
      adapterFor(adapter),
      {
        businessId: fixture.businessId,
        provider: 'easypost',
        environment: 'sandbox',
        displayName: 'Postage',
        apiKey: 'first',
        actorUserId: fixture.userId,
      },
    );

    const ref = { businessId: fixture.businessId, accountId: connected.accountId };
    await secrets.put({ ...ref, secretType: 'easypost_api_key', value: 'second' });

    expect(await secrets.read(ref, 'easypost_api_key')).toBe('second');

    const live = await harness.db
      .select()
      .from(shippingAccountSecrets)
      .where(
        and(
          eq(shippingAccountSecrets.accountId, connected.accountId),
          isNull(shippingAccountSecrets.retiredAt),
        ),
      );

    // The replaced key is retired rather than deleted, so a rotation can be
    // reconstructed afterwards.
    expect(live).toHaveLength(1);
  });
});

describe('taking an account out of service', () => {
  it('destroys the key and records why the account can no longer spend', async () => {
    const fixture = await seed();
    const adapter = new FakeShippingAdapter();

    const connected = await connectAccount(
      harness.db,
      secrets,
      fixture.audit,
      adapterFor(adapter),
      {
        businessId: fixture.businessId,
        provider: 'easypost',
        environment: 'sandbox',
        displayName: 'Postage',
        apiKey: 'key',
        actorUserId: fixture.userId,
      },
    );

    await disconnectAccount(harness.db, secrets, fixture.audit, {
      businessId: fixture.businessId,
      accountId: connected.accountId,
    });

    const ref = { businessId: fixture.businessId, accountId: connected.accountId };
    expect(await secrets.read(ref, 'easypost_api_key')).toBeNull();

    const [row] = await harness.db
      .select()
      .from(shippingAccounts)
      .where(eq(shippingAccounts.id, connected.accountId));
    expect(row?.status).toBe('disconnected');

    const events = await readBusinessAuditEvents(harness.db, fixture.businessId);
    expect(events.map((event) => event.action)).toContain('shipping.account.disconnected');
  });
});

describe('rechecking', () => {
  it('refreshes capabilities rather than trusting the ones from connection time', async () => {
    const fixture = await seed();
    const generous = new FakeShippingAdapter();
    const connected = await connectAccount(
      harness.db,
      secrets,
      fixture.audit,
      adapterFor(generous),
      {
        businessId: fixture.businessId,
        provider: 'easypost',
        environment: 'sandbox',
        displayName: 'Postage',
        apiKey: 'key',
        actorUserId: fixture.userId,
      },
    );

    // The account has been downgraded to a plan without refunds. A screen that
    // trusted the stored answer would keep offering a button that now fails
    // after the label has already been bought.
    const downgraded = new FakeShippingAdapter({ capabilities: { supportsVoid: false } });
    const result = await testAccount(harness.db, fixture.audit, adapterFor(downgraded), {
      businessId: fixture.businessId,
      accountId: connected.accountId,
    });

    expect(result.healthy).toBe(true);

    const [row] = await harness.db
      .select()
      .from(shippingAccounts)
      .where(eq(shippingAccounts.id, connected.accountId));
    expect(row?.capabilities).toMatchObject({ supportsVoid: false });
  });
});
