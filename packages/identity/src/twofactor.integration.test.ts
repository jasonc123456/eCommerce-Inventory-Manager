import { randomBytes } from 'node:crypto';

import { createHasher, loadKeyring } from '@eim/crypto';
import { recoveryCodes, totpCredentials, trustedDevices, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { URI, type TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTwoFactorService, secondFactorSatisfied } from './twofactor';

/**
 * Second factors against a real database.
 *
 * Replay prevention, single-use recovery codes, and revocation are all
 * conditional writes, so the database is the thing being tested as much as the
 * service is.
 */

let harness: TestDatabase;

const keyring = loadKeyring({
  keyring: JSON.stringify([{ version: 1, key: randomBytes(32).toString('base64') }]),
  activeVersion: 1,
});

const service = createTwoFactorService(createHasher('t'.repeat(48)), keyring);

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

async function createUser(): Promise<string> {
  sequence += 1;
  const [user] = await harness.db
    .insert(users)
    .values({ email: `twofactor-${String(sequence)}@example.invalid` })
    .returning({ id: users.id });

  return user!.id;
}

/** Produces the code an authenticator would show for a given moment. */
function codeAt(otpauthUri: string, now: Date): string {
  const parsed = URI.parse(otpauthUri);

  return (parsed as TOTP).generate({ timestamp: now.getTime() });
}

async function enrolled(): Promise<{ userId: string; otpauthUri: string; now: Date }> {
  const userId = await createUser();
  const now = new Date('2026-08-05T12:00:00.000Z');

  const { otpauthUri } = await service.beginTotpEnrollment(
    harness.db,
    { userId, accountLabel: 'user@example.invalid', issuer: 'Inventory Manager' },
    now,
  );

  await service.activateTotp(harness.db, userId, codeAt(otpauthUri, now), now);

  return { userId, otpauthUri, now };
}

describe('TOTP enrollment', () => {
  it('produces a scannable URI and a typeable key for the same secret', async () => {
    // Section 20 requires both, because a user setting this up on the phone
    // holding the authenticator has no camera to point at the screen.
    const userId = await createUser();
    const enrollment = await service.beginTotpEnrollment(harness.db, {
      userId,
      accountLabel: 'user@example.invalid',
      issuer: 'Inventory Manager',
    });

    expect(enrollment.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(enrollment.manualEntryKey).toMatch(/^[A-Z2-7]+$/);

    const parsed = URI.parse(enrollment.otpauthUri) as TOTP;
    expect(parsed.secret.base32).toBe(enrollment.manualEntryKey);
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
  });

  it('encrypts the seed, so a database copy alone cannot generate codes', async () => {
    const { userId, otpauthUri } = await enrolled();

    const [row] = await harness.db
      .select()
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, userId));

    const manualKey = (URI.parse(otpauthUri) as TOTP).secret.base32;

    expect(row!.encryptedSeed.startsWith('eim1.')).toBe(true);
    expect(row!.encryptedSeed).not.toContain(manualKey);
  });

  it('stays inactive until a real code is presented', async () => {
    // Section 20: enrollment requires successful verification before
    // activation, so an abandoned setup leaves nothing the user must satisfy.
    const userId = await createUser();
    await service.beginTotpEnrollment(harness.db, {
      userId,
      accountLabel: 'a@example.invalid',
      issuer: 'Test',
    });

    expect(await service.isTotpActive(harness.db, userId)).toBe(false);
    expect(await service.activateTotp(harness.db, userId, '000000')).toEqual({
      outcome: 'rejected',
    });
    expect(await service.isTotpActive(harness.db, userId)).toBe(false);
  });

  it('activates on a correct code', async () => {
    const { userId } = await enrolled();

    expect(await service.isTotpActive(harness.db, userId)).toBe(true);
  });

  it('replaces an abandoned enrollment rather than failing on the primary key', async () => {
    const userId = await createUser();

    const first = await service.beginTotpEnrollment(harness.db, {
      userId,
      accountLabel: 'a@example.invalid',
      issuer: 'Test',
    });
    const second = await service.beginTotpEnrollment(harness.db, {
      userId,
      accountLabel: 'a@example.invalid',
      issuer: 'Test',
    });

    expect(second.manualEntryKey).not.toBe(first.manualEntryKey);
  });
});

describe('TOTP verification', () => {
  it('accepts the current code', async () => {
    const { userId, otpauthUri } = await enrolled();
    const later = new Date('2026-08-05T12:05:00.000Z');

    expect(await service.verifyTotp(harness.db, userId, codeAt(otpauthUri, later), later)).toEqual({
      outcome: 'accepted',
    });
  });

  it('accepts a code one step old, which is section 20 window', async () => {
    const { userId, otpauthUri } = await enrolled();
    const issuedAt = new Date('2026-08-05T12:05:00.000Z');
    const arrivesAt = new Date('2026-08-05T12:05:31.000Z');

    expect(
      await service.verifyTotp(harness.db, userId, codeAt(otpauthUri, issuedAt), arrivesAt),
    ).toEqual({ outcome: 'accepted' });
  });

  it('refuses a code two steps old', async () => {
    const { userId, otpauthUri } = await enrolled();
    const issuedAt = new Date('2026-08-05T12:05:00.000Z');
    const tooLate = new Date('2026-08-05T12:06:05.000Z');

    expect(
      await service.verifyTotp(harness.db, userId, codeAt(otpauthUri, issuedAt), tooLate),
    ).toEqual({ outcome: 'rejected' });
  });

  it('tolerates the space authenticators display', async () => {
    const { userId, otpauthUri } = await enrolled();
    const later = new Date('2026-08-05T12:05:00.000Z');
    const code = codeAt(otpauthUri, later);

    expect(
      await service.verifyTotp(harness.db, userId, `${code.slice(0, 3)} ${code.slice(3)}`, later),
    ).toEqual({ outcome: 'accepted' });
  });

  it('refuses the same code twice inside its own window', async () => {
    // The plus-or-minus-one window means a code is valid for ninety seconds,
    // and without this it would be reusable for most of that.
    const { userId, otpauthUri } = await enrolled();
    const later = new Date('2026-08-05T12:05:00.000Z');
    const code = codeAt(otpauthUri, later);

    expect(await service.verifyTotp(harness.db, userId, code, later)).toEqual({
      outcome: 'accepted',
    });
    expect(await service.verifyTotp(harness.db, userId, code, later)).toEqual({
      outcome: 'replayed',
    });
  });

  it('lets only one of two simultaneous uses of a code through', async () => {
    const { userId, otpauthUri } = await enrolled();
    const later = new Date('2026-08-05T12:05:00.000Z');
    const code = codeAt(otpauthUri, later);

    const results = await Promise.all([
      service.verifyTotp(harness.db, userId, code, later),
      service.verifyTotp(harness.db, userId, code, later),
    ]);

    expect(results.filter((result) => result.outcome === 'accepted')).toHaveLength(1);
  });

  it('reports a user who never enrolled rather than rejecting', async () => {
    expect(await service.verifyTotp(harness.db, await createUser(), '000000')).toEqual({
      outcome: 'not_enrolled',
    });
  });

  it('refuses a code from somebody else authenticator', async () => {
    const mine = await enrolled();
    const theirs = await enrolled();
    const later = new Date('2026-08-05T12:05:00.000Z');

    expect(
      await service.verifyTotp(harness.db, mine.userId, codeAt(theirs.otpauthUri, later), later),
    ).toEqual({ outcome: 'rejected' });
  });
});

describe('recovery codes', () => {
  it('issues ten, stores only hashes, and returns them once', async () => {
    const userId = await createUser();
    const codes = await service.issueRecoveryCodes(harness.db, userId);

    expect(codes).toHaveLength(10);

    const stored = await harness.db
      .select()
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, userId));

    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(codes).not.toContain(row.codeHash);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('accepts a code once', async () => {
    const userId = await createUser();
    const [code] = await service.issueRecoveryCodes(harness.db, userId);

    expect(await service.consumeRecoveryCode(harness.db, userId, code!)).toBe(true);
    expect(await service.consumeRecoveryCode(harness.db, userId, code!)).toBe(false);
    expect(await service.countRemainingRecoveryCodes(harness.db, userId)).toBe(9);
  });

  it('accepts a code typed without hyphens, in lower case', async () => {
    const userId = await createUser();
    const [code] = await service.issueRecoveryCodes(harness.db, userId);

    expect(
      await service.consumeRecoveryCode(harness.db, userId, code!.replace(/-/g, '').toLowerCase()),
    ).toBe(true);
  });

  it('lets only one of two simultaneous uses spend a code', async () => {
    const userId = await createUser();
    const [code] = await service.issueRecoveryCodes(harness.db, userId);

    const results = await Promise.all([
      service.consumeRecoveryCode(harness.db, userId, code!),
      service.consumeRecoveryCode(harness.db, userId, code!),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses another user code', async () => {
    const mine = await createUser();
    const theirs = await createUser();
    const [code] = await service.issueRecoveryCodes(harness.db, theirs);
    await service.issueRecoveryCodes(harness.db, mine);

    expect(await service.consumeRecoveryCode(harness.db, mine, code!)).toBe(false);
  });

  it('invalidates the previous set on regeneration without deleting the record', async () => {
    const userId = await createUser();
    const [old] = await service.issueRecoveryCodes(harness.db, userId);
    await service.issueRecoveryCodes(harness.db, userId);

    expect(await service.consumeRecoveryCode(harness.db, userId, old!)).toBe(false);
    expect(await service.countRemainingRecoveryCodes(harness.db, userId)).toBe(10);

    const all = await harness.db
      .select()
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, userId));

    expect(all).toHaveLength(20);
  });
});

describe('trusted devices', () => {
  it('lasts thirty days and stores only a hash', async () => {
    const userId = await createUser();
    const now = new Date('2026-08-05T12:00:00.000Z');
    const { token, expiresAt } = await service.trustDevice(harness.db, { userId }, now);

    expect(expiresAt.getTime() - now.getTime()).toBe(30 * 24 * 60 * 60_000);

    const [row] = await harness.db
      .select()
      .from(trustedDevices)
      .where(eq(trustedDevices.userId, userId));

    expect(row!.tokenHash).not.toBe(token);
  });

  it('recognises its own token and nobody else', async () => {
    const mine = await createUser();
    const theirs = await createUser();
    const { token } = await service.trustDevice(harness.db, { userId: mine });

    expect(await service.isDeviceTrusted(harness.db, mine, token)).toBe(true);
    expect(await service.isDeviceTrusted(harness.db, theirs, token)).toBe(false);
    expect(await service.isDeviceTrusted(harness.db, mine, 'forged')).toBe(false);
  });

  it('stops working after thirty days', async () => {
    const userId = await createUser();
    const now = new Date('2026-08-05T12:00:00.000Z');
    const { token } = await service.trustDevice(harness.db, { userId }, now);

    const later = new Date(now.getTime() + 31 * 24 * 60 * 60_000);

    expect(await service.isDeviceTrusted(harness.db, userId, token, later)).toBe(false);
  });

  it('is revocable', async () => {
    const userId = await createUser();
    const { token } = await service.trustDevice(harness.db, { userId });

    expect(await service.revokeTrustedDevices(harness.db, userId)).toBe(1);
    expect(await service.isDeviceTrusted(harness.db, userId, token)).toBe(false);
  });
});

describe('disabling', () => {
  it('takes the recovery codes and trusted devices with it', async () => {
    // Both exist to work around the factor being removed, so leaving them would
    // leave a way in that the user thought they had turned off.
    const { userId } = await enrolled();
    const [code] = await service.issueRecoveryCodes(harness.db, userId);
    const { token } = await service.trustDevice(harness.db, { userId });

    await service.disableTotp(harness.db, userId);

    expect(await service.isTotpActive(harness.db, userId)).toBe(false);
    expect(await service.consumeRecoveryCode(harness.db, userId, code!)).toBe(false);
    expect(await service.isDeviceTrusted(harness.db, userId, token)).toBe(false);
  });
});

describe('secondFactorSatisfied', () => {
  it('is satisfied when no second factor is enrolled', () => {
    expect(
      secondFactorSatisfied({
        totpActive: false,
        deviceTrusted: false,
        factorVerifiedThisRequest: false,
      }),
    ).toBe(true);
  });

  it('needs a factor or a trusted device when one is enrolled', () => {
    expect(
      secondFactorSatisfied({
        totpActive: true,
        deviceTrusted: false,
        factorVerifiedThisRequest: false,
      }),
    ).toBe(false);
    expect(
      secondFactorSatisfied({
        totpActive: true,
        deviceTrusted: true,
        factorVerifiedThisRequest: false,
      }),
    ).toBe(true);
    expect(
      secondFactorSatisfied({
        totpActive: true,
        deviceTrusted: false,
        factorVerifiedThisRequest: true,
      }),
    ).toBe(true);
  });
});
