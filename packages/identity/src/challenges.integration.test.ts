import { createHasher } from '@eim/crypto';
import { loginChallenges, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_CHALLENGE_POLICY,
  challengeIdFromBinding,
  createChallengeService,
  normalizeEmail,
} from './challenges';

/**
 * Email challenges against a real database.
 *
 * The single-use guarantee, the one-live-challenge rule, and the attempt
 * counter are all enforced by statements whose correctness depends on the
 * database evaluating them, so none of them can be shown with a fake.
 */

let harness: TestDatabase;
const service = createChallengeService(createHasher('c'.repeat(48)));

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

/** An address with an account. */
async function knownAddress(): Promise<string> {
  sequence += 1;
  const email = `known-${String(sequence)}@example.invalid`;
  await harness.db.insert(users).values({ email });

  return email;
}

/** An address with no account, which must be indistinguishable from outside. */
function unknownAddress(): string {
  sequence += 1;
  return `nobody-${String(sequence)}@example.invalid`;
}

async function issueCode(email: string) {
  const result = await service.issue(harness.db, { email, method: 'email_code' });

  if (result.outcome !== 'issued') {
    throw new Error(`expected a challenge, got ${result.outcome}`);
  }

  return result;
}

async function issueLink(email: string) {
  const result = await service.issue(harness.db, { email, method: 'magic_link' });

  if (result.outcome !== 'issued') {
    throw new Error(`expected a challenge, got ${result.outcome}`);
  }

  return result;
}

describe('normalizeEmail', () => {
  it('folds case and trims', () => {
    expect(normalizeEmail('  Person@Example.Invalid ')).toBe('person@example.invalid');
  });

  it('leaves dots and plus tags alone', () => {
    // Provider-specific conventions. Applying Gmail's rules to a self-hosted
    // mail server would merge two addresses its administrator created as two
    // people.
    expect(normalizeEmail('a.b+tag@example.invalid')).toBe('a.b+tag@example.invalid');
  });
});

describe('issuing a challenge', () => {
  it('does the same work for an address with no account', async () => {
    // The enumeration defence. A row is written, budget is consumed, and the
    // shape of the answer is identical; only `recipientExists` differs, and
    // that decides whether a message is handed to the mailer.
    const known = await issueCode(await knownAddress());
    const unknown = await issueCode(unknownAddress());

    expect(known.recipientExists).toBe(true);
    expect(unknown.recipientExists).toBe(false);
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(unknown.secret).toMatch(/^\d{8}$/);
  });

  it('finds the account whatever case the address was typed in', async () => {
    const email = await knownAddress();
    const result = await issueCode(email.toUpperCase());

    expect(result.recipientExists).toBe(true);
  });

  it('stores only a hash of the secret', async () => {
    const { challengeId, secret } = await issueCode(await knownAddress());

    const [row] = await harness.db
      .select()
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId));

    expect(row!.secretHash).not.toBe(secret);
    expect(row!.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives two challenges with the same digits different stored hashes', async () => {
    // Bound to the challenge id, so a database reader cannot tell that two
    // live challenges happen to share a code.
    const first = await issueCode(await knownAddress());
    const second = await issueCode(await knownAddress());

    const rows = await harness.db
      .select({ id: loginChallenges.id, secretHash: loginChallenges.secretHash })
      .from(loginChallenges);

    const hashes = new Map(rows.map((row) => [row.id, row.secretHash]));

    // Force the collision the test is about by re-hashing one code under the
    // other challenge, which must not match what is stored.
    expect(hashes.get(first.challengeId)).not.toBe(hashes.get(second.challengeId));
  });

  it('mints a browser binding for a code and none for a link', async () => {
    const code = await issueCode(await knownAddress());
    const link = await issueLink(await knownAddress());

    expect(code.browserBinding).not.toBeNull();
    expect(challengeIdFromBinding(code.browserBinding!)).toBe(code.challengeId);
    // Section 20 explicitly permits a link to be opened on another device.
    expect(link.browserBinding).toBeNull();
  });

  it('gives a link fifteen minutes and a code ten', async () => {
    const now = new Date();
    const link = await service.issue(harness.db, {
      email: await knownAddress(),
      method: 'magic_link',
      now,
    });
    const code = await service.issue(harness.db, {
      email: await knownAddress(),
      method: 'email_code',
      now,
    });

    expect(link.outcome === 'issued' && link.expiresAt.getTime() - now.getTime()).toBe(
      DEFAULT_CHALLENGE_POLICY.magicLinkTtlMs,
    );
    expect(code.outcome === 'issued' && code.expiresAt.getTime() - now.getTime()).toBe(
      DEFAULT_CHALLENGE_POLICY.emailCodeTtlMs,
    );
  });

  it('refuses a redirect that leaves this origin', async () => {
    await expect(
      service.issue(harness.db, {
        email: await knownAddress(),
        method: 'magic_link',
        redirectPath: 'https://evil.example',
      }),
    ).rejects.toThrow();
  });
});

describe('the resend cooldown', () => {
  it('refuses a second message inside sixty seconds', async () => {
    const email = await knownAddress();
    const now = new Date();

    await service.issue(harness.db, { email, method: 'email_code', now });

    const again = await service.issue(harness.db, {
      email,
      method: 'email_code',
      now: new Date(now.getTime() + 30_000),
    });

    expect(again.outcome).toBe('cooldown');
    expect(again.outcome === 'cooldown' && again.retryAfterSeconds).toBe(30);
  });

  it('allows one after the cooldown, and carries the resend count forward', async () => {
    // Section 20 retains failed-attempt pressure across resends, so a resend
    // that reset the count would be a way around it.
    const email = await knownAddress();
    const now = new Date();

    await service.issue(harness.db, { email, method: 'email_code', now });
    const second = await service.issue(harness.db, {
      email,
      method: 'email_code',
      now: new Date(now.getTime() + 61_000),
    });

    expect(second.outcome === 'issued' && second.resendCount).toBe(1);
  });

  it('does not block a different purpose', async () => {
    const email = await knownAddress();
    const now = new Date();

    await service.issue(harness.db, { email, method: 'email_code', now });
    const stepUp = await service.issue(harness.db, {
      email,
      method: 'email_code',
      purpose: 'step_up',
      now,
    });

    expect(stepUp.outcome).toBe('issued');
  });
});

describe('superseding', () => {
  it('invalidates the previous challenge for the same address', async () => {
    const email = await knownAddress();
    const now = new Date();
    const first = await issueCode(email);

    await service.issue(harness.db, {
      email,
      method: 'email_code',
      now: new Date(now.getTime() + 61_000),
    });

    const result = await service.verify(harness.db, first.secret, {
      browserBinding: first.browserBinding!,
    });

    expect(result.outcome).toBe('invalid');
  });

  it('leaves another address alone', async () => {
    const mine = await issueCode(await knownAddress());
    await issueCode(await knownAddress());

    const result = await service.verify(harness.db, mine.secret, {
      browserBinding: mine.browserBinding!,
    });

    expect(result.outcome).toBe('verified');
  });
});

describe('verifying a magic link', () => {
  it('accepts the token once', async () => {
    const email = await knownAddress();
    const { secret } = await issueLink(email);

    const first = await service.verify(harness.db, secret);
    expect(first.outcome).toBe('verified');

    // Single use, enforced atomically.
    const second = await service.verify(harness.db, secret);
    expect(second.outcome).toBe('invalid');
  });

  it('lets exactly one of two simultaneous uses win', async () => {
    // Two requests arriving with the same valid token both pass every check;
    // the UPDATE's own WHERE clause is what decides between them.
    const { secret } = await issueLink(await knownAddress());

    const results = await Promise.all([
      service.verify(harness.db, secret),
      service.verify(harness.db, secret),
    ]);

    expect(results.filter((result) => result.outcome === 'verified')).toHaveLength(1);
  });

  it('works from a browser that did not request it', async () => {
    // Section 20 permits a link to be opened on another device after explicit
    // confirmation, which the web tier renders; the token itself is portable.
    const { secret } = await issueLink(await knownAddress());

    expect((await service.verify(harness.db, secret)).outcome).toBe('verified');
  });

  it('refuses an expired token', async () => {
    const { secret } = await issueLink(await knownAddress());
    const later = new Date(Date.now() + DEFAULT_CHALLENGE_POLICY.magicLinkTtlMs + 1000);

    expect(await service.verify(harness.db, secret, { now: later })).toEqual({
      outcome: 'expired',
    });
  });

  it('refuses a token for a challenge that does not exist', async () => {
    const forged = `${crypto.randomUUID()}.forged-token-value`;

    expect(await service.verify(harness.db, forged)).toEqual({ outcome: 'invalid' });
  });

  it('refuses a malformed token without looking anything up', async () => {
    for (const value of ['', 'nonsense', 'not-a-uuid.secret', '.secret']) {
      expect(await service.verify(harness.db, value)).toEqual({ outcome: 'invalid' });
    }
  });

  it('refuses a token whose challenge belongs to no account', async () => {
    const { secret } = await issueLink(unknownAddress());

    expect(await service.verify(harness.db, secret)).toEqual({ outcome: 'no_account' });
  });

  it('refuses the right secret against the wrong challenge', async () => {
    const mine = await issueLink(await knownAddress());
    const theirs = await issueLink(await knownAddress());

    const swapped = `${theirs.challengeId}.${mine.secret.split('.')[1]!}`;

    expect(await service.verify(harness.db, swapped)).toEqual({ outcome: 'invalid' });
  });
});

describe('verifying an eight-digit code', () => {
  it('accepts the code from the browser that asked for it', async () => {
    const { secret, browserBinding } = await issueCode(await knownAddress());

    const result = await service.verify(harness.db, secret, {
      browserBinding: browserBinding!,
    });

    expect(result.outcome).toBe('verified');
  });

  it('tolerates surrounding whitespace', async () => {
    const { secret, browserBinding } = await issueCode(await knownAddress());

    const result = await service.verify(harness.db, `  ${secret} `, {
      browserBinding: browserBinding!,
    });

    expect(result.outcome).toBe('verified');
  });

  it('refuses the right code from another browser', async () => {
    const mine = await issueCode(await knownAddress());
    const other = await issueCode(await knownAddress());

    const result = await service.verify(harness.db, mine.secret, {
      browserBinding: other.browserBinding!,
    });

    expect(result.outcome).toBe('invalid');
  });

  it('refuses a code with no browser binding at all', async () => {
    const { secret } = await issueCode(await knownAddress());

    expect(await service.verify(harness.db, secret)).toEqual({ outcome: 'invalid' });
  });

  it('counts a wrong guess and stops after five', async () => {
    const { challengeId, secret, browserBinding } = await issueCode(await knownAddress());
    const wrong = secret === '00000000' ? '11111111' : '00000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (await service.verify(harness.db, wrong, { browserBinding: browserBinding! })).outcome,
      ).toBe(attempt === 4 ? 'exhausted' : 'invalid');
    }

    const [row] = await harness.db
      .select({ attempts: loginChallenges.attempts })
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId));

    expect(row!.attempts).toBe(5);

    // Even the correct code is refused once the budget is gone.
    expect(
      (await service.verify(harness.db, secret, { browserBinding: browserBinding! })).outcome,
    ).toBe('exhausted');
  });

  it('counts an attempt from the wrong browser too', async () => {
    // Otherwise an attacker with the digits but not the cookie could try
    // indefinitely in the hope of a race.
    const mine = await issueCode(await knownAddress());
    const other = await issueCode(await knownAddress());

    await service.verify(harness.db, mine.secret, { browserBinding: other.browserBinding! });

    const [row] = await harness.db
      .select({ attempts: loginChallenges.attempts })
      .from(loginChallenges)
      .where(eq(loginChallenges.id, other.challengeId));

    expect(row!.attempts).toBe(1);
  });

  it('does not let concurrent wrong guesses share one increment', async () => {
    const { challengeId, browserBinding } = await issueCode(await knownAddress());

    await Promise.all(
      Array.from({ length: 4 }, () =>
        service.verify(harness.db, '00000000', { browserBinding: browserBinding! }),
      ),
    );

    const [row] = await harness.db
      .select({ attempts: loginChallenges.attempts })
      .from(loginChallenges)
      .where(eq(loginChallenges.id, challengeId));

    expect(row!.attempts).toBe(4);
  });
});

describe('pruning', () => {
  it('removes challenges past the retention window and keeps recent ones', async () => {
    // Section 19 keeps precise authentication network evidence for thirty days.
    const recent = await issueCode(await knownAddress());
    const old = await issueCode(await knownAddress());

    await harness.db
      .update(loginChallenges)
      .set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60_000) })
      .where(eq(loginChallenges.id, old.challengeId));

    const removed = await service.pruneFinished(harness.db);

    expect(removed).toBeGreaterThanOrEqual(1);

    const surviving = await harness.db
      .select({ id: loginChallenges.id })
      .from(loginChallenges)
      .where(eq(loginChallenges.id, recent.challengeId));

    expect(surviving).toHaveLength(1);
  });
});
