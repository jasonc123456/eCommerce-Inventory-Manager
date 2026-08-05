import { createHasher } from '@eim/crypto';
import {
  installationAdministratorPermissions,
  installationAdministrators,
  installationBootstrap,
  installationPermissions,
  users,
} from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

import { createBootstrapService } from './bootstrap';

/**
 * Creating the first installation administrator.
 *
 * Every test here is about a state transition that must happen exactly once, so
 * the assertions are mostly "and now it cannot happen again".
 */

let harness: TestDatabase;

const ADMIN_EMAIL = 'Owner@Example.Invalid';
const SETUP_SECRET = 'setup-secret-value-that-is-long-enough';

const service = createBootstrapService(createHasher('b'.repeat(48)), {
  initialAdminEmail: ADMIN_EMAIL,
  setupSecret: SETUP_SECRET,
});

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

/**
 * Returns the installation to its unclaimed state.
 *
 * Bootstrap is a single-row, once-only transition, so each test needs the row
 * put back rather than a fresh scope of its own.
 *
 * The final-administrator trigger exists precisely to make removing the last
 * administrator impossible, so it is disabled for the reset. That is not a
 * workaround for an over-strict rule: on a real installation the equivalent
 * state is reachable only through section 20's break-glass CLI with direct
 * deployment access, which is the point of the rule.
 */
async function resetInstallation(): Promise<void> {
  await harness.db.execute(sql`
    alter table installation_administrators
      disable trigger installation_administrators_retain_one
  `);

  try {
    await harness.db.delete(installationAdministratorPermissions);
    await harness.db.delete(installationAdministrators);
  } finally {
    await harness.db.execute(sql`
      alter table installation_administrators
        enable trigger installation_administrators_retain_one
    `);
  }

  await harness.db.update(installationBootstrap).set({
    completedAt: null,
    completedByUserId: null,
    failedAttempts: 0,
    lastAttemptAt: null,
    setupTokenHash: null,
    setupTokenIssuedAt: null,
    setupTokenExpiresAt: null,
  });

  await harness.db.delete(users);
}

afterEach(resetInstallation);

async function issueToken(): Promise<string> {
  const result = await service.requestSetupLink(harness.db, ADMIN_EMAIL);

  if (result.outcome !== 'issued') {
    throw new Error('expected a setup link');
  }

  return result.token;
}

describe('status', () => {
  it('starts open with no outstanding link', async () => {
    expect(await service.status(harness.db)).toMatchObject({
      open: true,
      completedAt: null,
      setupLinkOutstanding: false,
    });
  });
});

describe('requesting the setup link', () => {
  it('issues one for the configured address, whatever case it is typed in', async () => {
    const result = await service.requestSetupLink(harness.db, 'OWNER@example.invalid');

    expect(result.outcome).toBe('issued');
    expect((await service.status(harness.db)).setupLinkOutstanding).toBe(true);
  });

  it('stores only a hash of the token', async () => {
    const token = await issueToken();

    const [row] = await harness.db.select().from(installationBootstrap);

    expect(row!.setupTokenHash).not.toBe(token);
    expect(row!.setupTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says nothing different for the wrong address', async () => {
    // Distinguishing would tell an unauthenticated caller whether an
    // installation is claimed and what address claims it.
    const result = await service.requestSetupLink(harness.db, 'someone@else.invalid');

    expect(result).toEqual({ outcome: 'ignored' });
    expect((await service.status(harness.db)).setupLinkOutstanding).toBe(false);
  });

  it('counts a wrong address, so the health surface can see an attack', async () => {
    await service.requestSetupLink(harness.db, 'someone@else.invalid');
    await service.requestSetupLink(harness.db, 'another@else.invalid');

    expect((await service.status(harness.db)).failedAttempts).toBe(2);
  });

  it('replaces an outstanding link rather than adding a second', async () => {
    const first = await issueToken();
    const second = await issueToken();

    expect(first).not.toBe(second);

    expect(await service.complete(harness.db, { token: first, setupSecret: SETUP_SECRET })).toEqual(
      { outcome: 'refused' },
    );
  });

  it('is unavailable when the installation configured no setup secret', async () => {
    const unconfigured = createBootstrapService(createHasher('b'.repeat(48)), {
      initialAdminEmail: ADMIN_EMAIL,
    });

    expect(await unconfigured.requestSetupLink(harness.db, ADMIN_EMAIL)).toEqual({
      outcome: 'ignored',
    });
  });
});

describe('completing bootstrap', () => {
  it('creates the administrator with every installation permission', async () => {
    // There is nobody to grant them later, and an administrator who cannot add
    // another administrator has locked the installation on its first day.
    const token = await issueToken();

    const result = await service.complete(harness.db, {
      token,
      setupSecret: SETUP_SECRET,
      displayName: 'Owner',
    });

    expect(result.outcome).toBe('completed');

    const granted = await harness.db
      .select({ permission: installationAdministratorPermissions.permission })
      .from(installationAdministratorPermissions);

    expect(granted.map((row) => row.permission).sort()).toEqual(
      [...installationPermissions].sort(),
    );
  });

  it('stores the address normalized and keeps what the operator typed', async () => {
    const token = await issueToken();
    const result = await service.complete(harness.db, { token, setupSecret: SETUP_SECRET });

    const [user] = await harness.db
      .select()
      .from(users)
      .where(eq(users.id, result.outcome === 'completed' ? result.userId : ''));

    expect(user!.email).toBe('owner@example.invalid');
    expect(user!.emailDisplay).toBe(ADMIN_EMAIL);
  });

  it('needs the setup secret as well as the link', async () => {
    // Possession of the inbox alone is not enough.
    const token = await issueToken();

    expect(await service.complete(harness.db, { token, setupSecret: 'wrong' })).toEqual({
      outcome: 'refused',
    });
    expect((await service.status(harness.db)).open).toBe(true);
  });

  it('needs the link as well as the setup secret', async () => {
    // And possession of the .env file alone is not enough either.
    await issueToken();

    expect(
      await service.complete(harness.db, { token: 'forged', setupSecret: SETUP_SECRET }),
    ).toEqual({ outcome: 'refused' });
  });

  it('gives the same answer whichever factor was wrong', async () => {
    const token = await issueToken();

    const wrongSecret = await service.complete(harness.db, { token, setupSecret: 'wrong' });
    const wrongToken = await service.complete(harness.db, {
      token: 'forged',
      setupSecret: SETUP_SECRET,
    });

    expect(wrongSecret).toEqual(wrongToken);
  });

  it('refuses an expired link', async () => {
    const token = await issueToken();
    const later = new Date(Date.now() + 16 * 60_000);

    expect(await service.complete(harness.db, { token, setupSecret: SETUP_SECRET }, later)).toEqual(
      { outcome: 'refused' },
    );
  });

  it('counts every refusal', async () => {
    const token = await issueToken();

    await service.complete(harness.db, { token, setupSecret: 'wrong' });
    await service.complete(harness.db, { token, setupSecret: 'wrong' });

    expect((await service.status(harness.db)).failedAttempts).toBe(2);
  });
});

describe('closing permanently', () => {
  it('discards the token and refuses a second attempt', async () => {
    const token = await issueToken();
    await service.complete(harness.db, { token, setupSecret: SETUP_SECRET });

    const status = await service.status(harness.db);
    expect(status.open).toBe(false);
    expect(status.setupLinkOutstanding).toBe(false);

    expect(await service.complete(harness.db, { token, setupSecret: SETUP_SECRET })).toEqual({
      outcome: 'already_completed',
    });
  });

  it('refuses to issue another setup link once closed', async () => {
    const token = await issueToken();
    await service.complete(harness.db, { token, setupSecret: SETUP_SECRET });

    expect(await service.requestSetupLink(harness.db, ADMIN_EMAIL)).toEqual({
      outcome: 'ignored',
    });
  });

  it('stays closed when the last administrator is removed', async () => {
    // Bootstrap closure is a recorded fact, not "is the administrator table
    // empty". The latter would reopen bootstrap at exactly the moment an
    // attacker would most like it to.
    const token = await issueToken();
    await service.complete(harness.db, { token, setupSecret: SETUP_SECRET });

    await harness.db.execute(sql`
      alter table installation_administrators
        disable trigger installation_administrators_retain_one
    `);
    await harness.db.delete(installationAdministratorPermissions);
    await harness.db.delete(installationAdministrators);
    await harness.db.execute(sql`
      alter table installation_administrators
        enable trigger installation_administrators_retain_one
    `);

    expect((await service.status(harness.db)).open).toBe(false);
  });

  it('lets only one of two simultaneous completions win', async () => {
    const token = await issueToken();

    const results = await Promise.all([
      service.complete(harness.db, { token, setupSecret: SETUP_SECRET }),
      service.complete(harness.db, { token, setupSecret: SETUP_SECRET }),
    ]);

    expect(results.filter((result) => result.outcome === 'completed')).toHaveLength(1);
    expect(await harness.db.select().from(installationAdministrators)).toHaveLength(1);
  });
});
