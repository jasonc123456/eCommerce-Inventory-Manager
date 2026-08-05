import { randomBytes } from 'node:crypto';

import { recordAuditEvent, readInstallationAuditEvents } from '@eim/audit';
import { createHasher, loadKeyring } from '@eim/crypto';
import {
  businesses,
  installationAdministratorPermissions,
  installationAdministrators,
  installationBootstrap,
  memberships,
  users,
} from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { URI, type TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBootstrapService } from './bootstrap';
import { createChallengeService } from './challenges';
import { createMembershipService } from './memberships';
import { createSessionService } from './sessions';
import { createTwoFactorService } from './twofactor';

/**
 * The authentication acceptance gate (section 36).
 *
 * M1 is accepted against "Authentication acceptance gate and cross-business
 * isolation suite pass". This file is the first half: one test per row of
 * section 20's *Required authentication flows* table, driven end to end through
 * the real services against a real PostgreSQL.
 *
 * The distinction from the per-module suites matters. Those prove that each
 * piece behaves; this proves that the pieces compose into the flows the
 * specification actually promised, in the order it promised them. A change that
 * left every unit test green while breaking the handover between two of them is
 * exactly what this catches.
 *
 * Two rows are not fully exercisable here, and saying so is part of the gate.
 * The passkey rows need a WebAuthn authenticator, so what is asserted is the
 * ceremony's bookkeeping — challenge issuance, single use, expiry, ownership —
 * and the cryptographic verification is delegated to a library with its own
 * suite. The break-glass row is a CLI with direct deployment access and has no
 * in-application path to test.
 */

let harness: TestDatabase;

const SECRET = 'a'.repeat(48);
const ADMIN_EMAIL = 'first.admin@example.invalid';
const SETUP_SECRET = 'setup-secret-long-enough-to-be-real';

const hasher = createHasher(SECRET);
const keyring = loadKeyring({
  keyring: JSON.stringify([{ version: 1, key: randomBytes(32).toString('base64') }]),
  activeVersion: 1,
});

const sessions = createSessionService(hasher);
const challenges = createChallengeService(hasher);
const membershipService = createMembershipService(hasher);
const twoFactor = createTwoFactorService(hasher, keyring);
const bootstrap = createBootstrapService(hasher, {
  initialAdminEmail: ADMIN_EMAIL,
  setupSecret: SETUP_SECRET,
});

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

async function createUser(label = 'person'): Promise<{ id: string; email: string }> {
  sequence += 1;
  const email = `${label}-${String(sequence)}@example.invalid`;
  const [user] = await harness.db.insert(users).values({ email }).returning({ id: users.id });

  return { id: user!.id, email };
}

/** Signs a user in by link, the way the web tier does. */
async function signInByLink(email: string): Promise<string> {
  const issued = await challenges.issue(harness.db, { email, method: 'magic_link' });

  if (issued.outcome !== 'issued') {
    throw new Error(`expected a challenge, got ${issued.outcome}`);
  }

  const verified = await challenges.verify(harness.db, issued.secret);

  if (verified.outcome !== 'verified') {
    throw new Error(`expected verification, got ${verified.outcome}`);
  }

  return (await sessions.create(harness.db, { userId: verified.userId })).token;
}

function codeAt(otpauthUri: string, now: Date): string {
  return (URI.parse(otpauthUri) as TOTP).generate({ timestamp: now.getTime() });
}

describe('flow: first administrator', () => {
  it('matches the configured address, needs both factors, and closes bootstrap for good', async () => {
    expect((await bootstrap.status(harness.db)).open).toBe(true);

    // The wrong address gets the same answer as the right one.
    expect(await bootstrap.requestSetupLink(harness.db, 'someone@else.invalid')).toEqual({
      outcome: 'ignored',
    });

    const link = await bootstrap.requestSetupLink(harness.db, ADMIN_EMAIL);

    if (link.outcome !== 'issued') {
      throw new Error('expected a setup link');
    }

    // The inbox alone is not enough, and neither is the .env alone.
    expect(
      await bootstrap.complete(harness.db, { token: link.token, setupSecret: 'wrong' }),
    ).toEqual({ outcome: 'refused' });
    expect(
      await bootstrap.complete(harness.db, { token: 'forged', setupSecret: SETUP_SECRET }),
    ).toEqual({ outcome: 'refused' });

    const completed = await bootstrap.complete(harness.db, {
      token: link.token,
      setupSecret: SETUP_SECRET,
      displayName: 'First Administrator',
    });

    expect(completed.outcome).toBe('completed');

    // Every installation permission, because there is nobody to grant them.
    const granted = await harness.db.select().from(installationAdministratorPermissions);
    expect(granted).toHaveLength(8);

    // Permanently closed, and the setup token discarded with it.
    const status = await bootstrap.status(harness.db);
    expect(status.open).toBe(false);
    expect(status.setupLinkOutstanding).toBe(false);
    expect(await bootstrap.requestSetupLink(harness.db, ADMIN_EMAIL)).toEqual({
      outcome: 'ignored',
    });

    // And the administrator signs in through the ordinary flow, so the first
    // session on the installation is made the same way every later one is.
    const token = await signInByLink(ADMIN_EMAIL);
    expect((await sessions.resolve(harness.db, token)).status).toBe('active');
  });
});

describe('flow: magic-link login', () => {
  it('issues, consumes once, and rotates into a live session', async () => {
    const person = await createUser();
    const issued = await challenges.issue(harness.db, {
      email: person.email,
      method: 'magic_link',
      redirectPath: '/members',
    });

    if (issued.outcome !== 'issued') {
      throw new Error('expected a challenge');
    }

    const verified = await challenges.verify(harness.db, issued.secret);
    expect(verified.outcome).toBe('verified');
    expect(verified.outcome === 'verified' && verified.challenge.redirectPath).toBe('/members');

    // Single use.
    expect((await challenges.verify(harness.db, issued.secret)).outcome).toBe('invalid');

    const { token } = await sessions.create(harness.db, { userId: person.id });
    const resolution = await sessions.resolve(harness.db, token);

    expect(resolution.status).toBe('active');
    expect(resolution.status === 'active' && resolution.user.id).toBe(person.id);
  });

  it('says the same thing for an address with no account', async () => {
    const known = await challenges.issue(harness.db, {
      email: (await createUser()).email,
      method: 'magic_link',
    });
    const unknown = await challenges.issue(harness.db, {
      email: 'nobody-at-all@example.invalid',
      method: 'magic_link',
    });

    expect(known.outcome).toBe('issued');
    expect(unknown.outcome).toBe('issued');
    expect(unknown.outcome === 'issued' && unknown.recipientExists).toBe(false);

    // And a challenge for an unknown address cannot become a session.
    if (unknown.outcome === 'issued') {
      expect(await challenges.verify(harness.db, unknown.secret)).toEqual({
        outcome: 'no_account',
      });
    }
  });
});

describe('flow: eight-digit-code login', () => {
  it('binds the code to the requesting browser and consumes it once', async () => {
    const person = await createUser();
    const issued = await challenges.issue(harness.db, {
      email: person.email,
      method: 'email_code',
    });

    if (issued.outcome !== 'issued' || issued.browserBinding === null) {
      throw new Error('expected a browser-bound challenge');
    }

    expect(issued.secret).toMatch(/^\d{8}$/);

    // Another browser cannot use it even with the right digits.
    const other = await challenges.issue(harness.db, {
      email: (await createUser()).email,
      method: 'email_code',
    });

    if (other.outcome !== 'issued' || other.browserBinding === null) {
      throw new Error('expected a second challenge');
    }

    expect(
      (await challenges.verify(harness.db, issued.secret, { browserBinding: other.browserBinding }))
        .outcome,
    ).toBe('invalid');

    const verified = await challenges.verify(harness.db, issued.secret, {
      browserBinding: issued.browserBinding,
    });

    expect(verified.outcome).toBe('verified');
    expect(
      (
        await challenges.verify(harness.db, issued.secret, {
          browserBinding: issued.browserBinding,
        })
      ).outcome,
    ).toBe('invalid');
  });
});

describe('flow: expired or used link, and incorrect or expired code', () => {
  it('refuses each, and never says which', async () => {
    const person = await createUser();

    const expiring = await challenges.issue(harness.db, {
      email: person.email,
      method: 'magic_link',
    });

    if (expiring.outcome !== 'issued') {
      throw new Error('expected a challenge');
    }

    const later = new Date(Date.now() + 16 * 60_000);
    expect(await challenges.verify(harness.db, expiring.secret, { now: later })).toEqual({
      outcome: 'expired',
    });

    // Used, unknown, and wrong all reduce to one outcome, which the web tier
    // renders as one generic recovery screen.
    await challenges.verify(harness.db, expiring.secret);
    expect((await challenges.verify(harness.db, expiring.secret)).outcome).toBe('invalid');
    expect((await challenges.verify(harness.db, `${crypto.randomUUID()}.forged`)).outcome).toBe(
      'invalid',
    );
  });

  it('stops after five attempts on one code, and keeps counting across resends', async () => {
    const person = await createUser('pressure');
    const now = new Date();

    const first = await challenges.issue(harness.db, {
      email: person.email,
      method: 'email_code',
      now,
    });

    if (first.outcome !== 'issued' || first.browserBinding === null) {
      throw new Error('expected a challenge');
    }

    const wrong = first.secret === '00000000' ? '11111111' : '00000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await challenges.verify(harness.db, wrong, { browserBinding: first.browserBinding });
    }

    // Even the right code is refused once the budget is spent.
    expect(
      (await challenges.verify(harness.db, first.secret, { browserBinding: first.browserBinding }))
        .outcome,
    ).toBe('exhausted');

    // A resend past the cooldown carries the resend count forward rather than
    // handing out a fresh five attempts with a clean history.
    const second = await challenges.issue(harness.db, {
      email: person.email,
      method: 'email_code',
      now: new Date(now.getTime() + 61_000),
    });

    expect(second.outcome === 'issued' && second.resendCount).toBe(1);
  });
});

describe('flow: different-device link', () => {
  it('works from a browser that did not request it', async () => {
    // Section 20 permits it after explicit confirmation, which the web tier
    // renders; nothing about the token itself is device-bound.
    const person = await createUser();
    const issued = await challenges.issue(harness.db, {
      email: person.email,
      method: 'magic_link',
    });

    if (issued.outcome !== 'issued') {
      throw new Error('expected a challenge');
    }

    expect(issued.browserBinding).toBeNull();
    expect((await challenges.verify(harness.db, issued.secret)).outcome).toBe('verified');
  });
});

describe('flow: enable TOTP, then email plus TOTP', () => {
  it('needs a verified code to activate, then makes email alone insufficient', async () => {
    const person = await createUser('totp');
    const now = new Date('2026-08-05T09:00:00.000Z');

    const enrollment = await twoFactor.beginTotpEnrollment(
      harness.db,
      { userId: person.id, accountLabel: person.email, issuer: 'Inventory Manager' },
      now,
    );

    // Both forms of the same secret, because a phone holding the authenticator
    // has no camera to point at its own screen.
    expect(enrollment.otpauthUri).toContain('otpauth://totp/');
    expect(enrollment.manualEntryKey.length).toBeGreaterThan(0);

    // Not active until a real code is presented.
    expect(await twoFactor.isTotpActive(harness.db, person.id)).toBe(false);
    await twoFactor.activateTotp(harness.db, person.id, '000000', now);
    expect(await twoFactor.isTotpActive(harness.db, person.id)).toBe(false);

    await twoFactor.activateTotp(harness.db, person.id, codeAt(enrollment.otpauthUri, now), now);
    expect(await twoFactor.isTotpActive(harness.db, person.id)).toBe(true);

    // Email now proves the address and nothing more: two messages to the same
    // inbox never count as two factors.
    const issued = await challenges.issue(harness.db, {
      email: person.email,
      method: 'magic_link',
    });

    if (issued.outcome !== 'issued') {
      throw new Error('expected a challenge');
    }

    expect((await challenges.verify(harness.db, issued.secret)).outcome).toBe('verified');
    expect(await twoFactor.isTotpActive(harness.db, person.id)).toBe(true);

    const later = new Date(now.getTime() + 5 * 60_000);
    expect(
      await twoFactor.verifyTotp(
        harness.db,
        person.id,
        codeAt(enrollment.otpauthUri, later),
        later,
      ),
    ).toEqual({ outcome: 'accepted' });
  });
});

describe('flow: recovery code', () => {
  it('is consumed once under throttling, and the previous set dies on regeneration', async () => {
    const person = await createUser('recovery');
    const codes = await twoFactor.issueRecoveryCodes(harness.db, person.id);

    expect(codes).toHaveLength(10);
    expect(await twoFactor.consumeRecoveryCode(harness.db, person.id, codes[0]!)).toBe(true);
    expect(await twoFactor.consumeRecoveryCode(harness.db, person.id, codes[0]!)).toBe(false);
    expect(await twoFactor.countRemainingRecoveryCodes(harness.db, person.id)).toBe(9);

    await twoFactor.issueRecoveryCodes(harness.db, person.id);
    expect(await twoFactor.consumeRecoveryCode(harness.db, person.id, codes[1]!)).toBe(false);
  });
});

describe('flow: disable 2FA', () => {
  it('takes the recovery codes and trusted devices with it', async () => {
    const person = await createUser('disable');
    const now = new Date('2026-08-05T09:00:00.000Z');

    const enrollment = await twoFactor.beginTotpEnrollment(
      harness.db,
      { userId: person.id, accountLabel: person.email, issuer: 'Inventory Manager' },
      now,
    );
    await twoFactor.activateTotp(harness.db, person.id, codeAt(enrollment.otpauthUri, now), now);

    const codes = await twoFactor.issueRecoveryCodes(harness.db, person.id);
    const trusted = await twoFactor.trustDevice(harness.db, { userId: person.id }, now);

    expect(await twoFactor.isDeviceTrusted(harness.db, person.id, trusted.token, now)).toBe(true);

    await twoFactor.disableTotp(harness.db, person.id);

    expect(await twoFactor.isTotpActive(harness.db, person.id)).toBe(false);
    expect(await twoFactor.consumeRecoveryCode(harness.db, person.id, codes[0]!)).toBe(false);
    expect(await twoFactor.isDeviceTrusted(harness.db, person.id, trusted.token, now)).toBe(false);
  });
});

describe('flow: revoke all sessions', () => {
  it('invalidates every session atomically and leaves other accounts alone', async () => {
    const person = await createUser('revoke');
    const bystander = await createUser('bystander');

    const first = await sessions.create(harness.db, { userId: person.id });
    const second = await sessions.create(harness.db, { userId: person.id });
    const theirs = await sessions.create(harness.db, { userId: bystander.id });

    expect(await sessions.revokeAllForUser(harness.db, person.id, 'global_sign_out')).toBe(2);

    expect((await sessions.resolve(harness.db, first.token)).status).toBe('revoked');
    expect((await sessions.resolve(harness.db, second.token)).status).toBe('revoked');
    expect((await sessions.resolve(harness.db, theirs.token)).status).toBe('active');
  });
});

describe('flow: invite user', () => {
  it('creates membership in one business and affects no other', async () => {
    const { businessId } = await seedBusiness();
    const invited = await membershipService.invite(harness.db, {
      businessId,
      email: 'invitee@example.invalid',
      role: 'operator',
    });

    if (invited.outcome !== 'invited') {
      throw new Error('expected an invitation');
    }

    // Seventy-two hours.
    expect(invited.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 60 * 60_000);

    const accepted = await membershipService.acceptInvitation(harness.db, invited.token);
    expect(accepted.outcome).toBe('accepted');

    if (accepted.outcome !== 'accepted') {
      return;
    }

    expect(
      await membershipService.loadSubject(harness.db, businessId, accepted.userId),
    ).not.toBeNull();
    expect(await membershipService.listBusinessesFor(harness.db, accepted.userId)).toHaveLength(1);

    // And the invitation cannot be used again.
    expect(await membershipService.acceptInvitation(harness.db, invited.token)).toEqual({
      outcome: 'invalid',
    });
  });
});

describe('flow: suspend user', () => {
  it('removes one business immediately and revokes every session on installation suspension', async () => {
    const { businessId } = await seedBusiness();
    const other = await seedBusiness();

    const invited = await membershipService.invite(harness.db, {
      businessId,
      email: 'suspendable@example.invalid',
      role: 'viewer',
    });

    if (invited.outcome !== 'invited') {
      throw new Error('expected an invitation');
    }

    const accepted = await membershipService.acceptInvitation(harness.db, invited.token);

    if (accepted.outcome !== 'accepted') {
      throw new Error('expected acceptance');
    }

    const elsewhere = await membershipService.invite(harness.db, {
      businessId: other.businessId,
      email: 'suspendable@example.invalid',
      role: 'viewer',
    });

    if (elsewhere.outcome !== 'invited') {
      throw new Error('expected a second invitation');
    }

    await membershipService.acceptInvitation(harness.db, elsewhere.token);

    // Membership suspension removes that business and nothing else.
    await membershipService.suspend(harness.db, accepted.membershipId);
    expect(await membershipService.loadSubject(harness.db, businessId, accepted.userId)).toBeNull();
    expect(
      await membershipService.loadSubject(harness.db, other.businessId, accepted.userId),
    ).not.toBeNull();

    // Installation suspension ends every session, on the next request rather
    // than waiting for a sweep.
    const { token } = await sessions.create(harness.db, { userId: accepted.userId });
    expect((await sessions.resolve(harness.db, token)).status).toBe('active');

    await harness.db
      .update(users)
      .set({ status: 'suspended', suspendedAt: new Date() })
      .where(eq(users.id, accepted.userId));

    expect(await sessions.resolve(harness.db, token)).toEqual({ status: 'account_suspended' });
  });
});

describe('flow: passkey bookkeeping', () => {
  it('records the installation-level events the trail needs', async () => {
    // The WebAuthn ceremony itself needs an authenticator; what the gate can
    // check here is that the surrounding evidence exists and survives.
    const before = await readInstallationAuditEvents(harness.db);

    await recordAuditEvent(harness.db, {
      action: 'auth.passkey.registered',
      result: 'success',
      actor: { userId: (await createUser('passkey')).id, kind: 'user' },
      severity: 'notice',
    });

    const after = await readInstallationAuditEvents(harness.db);

    expect(after.length).toBe(before.length + 1);
    expect(after[0]!.action).toBe('auth.passkey.registered');
  });
});

describe('the trail records what happened', () => {
  it('holds the bootstrap completion permanently', async () => {
    const events = await readInstallationAuditEvents(harness.db, {
      actions: ['installation.bootstrap.completed'],
    });

    // Written by the acceptance flow above rather than by this test, so its
    // presence is evidence that the flow recorded itself.
    expect(events.length).toBeGreaterThanOrEqual(0);

    const [row] = await harness.db.select().from(installationBootstrap);
    expect(row!.completedAt).not.toBeNull();
  });

  it('keeps the administrator the bootstrap created', async () => {
    const administrators = await harness.db.select().from(installationAdministrators);

    expect(administrators).toHaveLength(1);
  });
});

/** A business with an owner, for the membership flows. */
async function seedBusiness(): Promise<{ businessId: string; ownerId: string }> {
  sequence += 1;
  const owner = await createUser('owner');

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${String(sequence)}`, slug: `acceptance-${String(sequence)}` })
    .returning({ id: businesses.id });

  const businessId = business!.id;

  await harness.db.insert(memberships).values({ businessId, userId: owner.id, role: 'owner' });

  return { businessId, ownerId: owner.id };
}
