import { randomUUID } from 'node:crypto';

import { generateEmailCode, generateToken, type KeyedHasher } from '@eim/crypto';
import {
  loginChallenges,
  users,
  type ChallengeMethod,
  type ChallengePurpose,
  type Database,
  type LoginChallenge,
} from '@eim/db';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

/**
 * Email sign-in challenges: magic links and eight-digit codes (section 20).
 *
 * The design is shaped by one requirement that touches everything else:
 * "Registration is invitation/preapproval-only. Login and request responses
 * never reveal whether an account or invitation exists."
 *
 * So a request for an address nobody has heard of does the same work as a
 * request for a real one. It writes a challenge row, consumes the same
 * rate-limit budget, takes a comparable amount of time, and returns the same
 * thing. The only difference is that no message is sent, and the caller learns
 * that from `recipientExists` — which exists to decide whether to hand the
 * message to the mailer, and must never reach the browser.
 *
 * Verification failures are similarly uniform from outside. This module returns
 * distinct reasons because the audit trail should record which one happened;
 * section 20 requires the HTTP layer to render one generic recovery screen for
 * all of them.
 */

export interface ChallengePolicy {
  /** Section 20: fifteen minutes for a link. */
  readonly magicLinkTtlMs: number;
  /** Section 20: ten minutes for a code. */
  readonly emailCodeTtlMs: number;
  /** Section 20: five verification attempts per code. */
  readonly maxAttempts: number;
  /** Section 20: a sixty-second resend cooldown. */
  readonly resendCooldownMs: number;
  /**
   * How long a finished challenge is kept.
   *
   * Section 19 retains precise authentication network evidence for thirty days,
   * and the row carries the requesting address and user agent.
   */
  readonly retentionMs: number;
}

const MINUTE = 60_000;

export const DEFAULT_CHALLENGE_POLICY: ChallengePolicy = {
  magicLinkTtlMs: 15 * MINUTE,
  emailCodeTtlMs: 10 * MINUTE,
  maxAttempts: 5,
  resendCooldownMs: MINUTE,
  retentionMs: 30 * 24 * 60 * MINUTE,
};

export type ChallengeWriter = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export interface IssueChallengeInput {
  readonly email: string;
  readonly method: ChallengeMethod;
  readonly purpose?: ChallengePurpose;
  /** Validated against a local allowlist by the caller before it gets here. */
  readonly redirectPath?: string | null;
  readonly requestIp?: string | null;
  readonly requestUserAgent?: string | null;
  readonly now?: Date;
}

export type IssueChallengeResult =
  | {
      readonly outcome: 'issued';
      readonly challengeId: string;
      /**
       * The value that goes in the message: the whole magic-link token, or the
       * eight digits. Returned once, never stored, never logged.
       */
      readonly secret: string;
      readonly expiresAt: Date;
      /**
       * The value the browser-binding cookie must carry, for a code challenge.
       *
       * Minted here rather than by the caller because it has to contain the
       * challenge id, and the id is generated inside this call. Null for a magic
       * link, which section 20 explicitly permits to be opened on another
       * device after confirmation.
       */
      readonly browserBinding: string | null;
      /**
       * Whether an account exists for this address.
       *
       * The one asymmetry, and it decides only whether a message is handed to
       * the mailer. It must not change the response, the status code, or the
       * time taken, and it must never be serialized to the browser.
       */
      readonly recipientExists: boolean;
      readonly resendCount: number;
    }
  | {
      /** Section 20's sixty-second resend cooldown. */
      readonly outcome: 'cooldown';
      readonly retryAfterSeconds: number;
    };

export type VerifyChallengeResult =
  | { readonly outcome: 'verified'; readonly challenge: LoginChallenge; readonly userId: string }
  /** Unknown, superseded, already used, or simply wrong. */
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'expired' }
  /** Five wrong attempts. A new challenge is required. */
  | { readonly outcome: 'exhausted' }
  /** A code presented from a browser other than the one that asked for it. */
  | { readonly outcome: 'wrong_browser' }
  /**
   * The challenge is valid but belongs to no account. Verification cannot
   * succeed, and the caller records the outcome without creating anything.
   */
  | { readonly outcome: 'no_account' };

export interface ChallengeService {
  issue(db: ChallengeWriter, input: IssueChallengeInput): Promise<IssueChallengeResult>;
  verify(
    db: ChallengeWriter,
    presented: string,
    options?: { readonly browserBinding?: string; readonly now?: Date },
  ): Promise<VerifyChallengeResult>;
  /** The keyed fingerprint the rate limiter and pressure tracker key on. */
  fingerprintOf(email: string): string;
  supersedeLive(
    db: ChallengeWriter,
    email: string,
    purpose?: ChallengePurpose,
    now?: Date,
  ): Promise<number>;
  pruneFinished(db: ChallengeWriter, now?: Date): Promise<number>;
}

/**
 * Normalizes an address for identity (section 19).
 *
 * Case folding and trimming only. Deliberately not stripping dots or `+tags`:
 * those are provider-specific conventions, and applying Gmail's rules to a
 * self-hosted mail server would merge two addresses that its administrator
 * created as two people.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createChallengeService(
  hasher: KeyedHasher,
  policy: ChallengePolicy = DEFAULT_CHALLENGE_POLICY,
): ChallengeService {
  const fingerprintOf = (email: string): string =>
    hasher.hash('email_fingerprint', normalizeEmail(email));

  const secretDomain = (method: ChallengeMethod): 'magic_link' | 'email_code' =>
    method === 'magic_link' ? 'magic_link' : 'email_code';

  return {
    fingerprintOf,

    async issue(db, input) {
      const now = input.now ?? new Date();
      const purpose = input.purpose ?? 'login';
      const normalized = normalizeEmail(input.email);
      const fingerprint = fingerprintOf(normalized);

      const [live] = await db
        .select()
        .from(loginChallenges)
        .where(
          and(
            eq(loginChallenges.emailFingerprint, fingerprint),
            eq(loginChallenges.purpose, purpose),
            isNull(loginChallenges.consumedAt),
            isNull(loginChallenges.supersededAt),
          ),
        );

      if (live !== undefined) {
        const sinceLastSend = now.getTime() - live.lastSentAt.getTime();

        // The cooldown is measured from the last message, not from the last
        // request, so a rejected resend does not restart it.
        if (sinceLastSend < policy.resendCooldownMs && live.expiresAt.getTime() > now.getTime()) {
          return {
            outcome: 'cooldown',
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((policy.resendCooldownMs - sinceLastSend) / 1000),
            ),
          };
        }
      }

      await this.supersedeLive(db, normalized, purpose, now);

      // Looked up after superseding rather than before, so the two behave the
      // same for an address with and without an account.
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(sql`lower(${users.email})`, normalized), isNull(users.deletedAt)));

      // Generated here rather than by the database, because the secret's hash is
      // bound to it: a code that happens to match another live challenge's digits
      // must not produce the same stored hash.
      const challengeId = randomUUID();
      const secret =
        input.method === 'magic_link' ? `${challengeId}.${generateToken()}` : generateEmailCode();

      // A code carries no identifier of its own — it is eight digits — so the
      // cookie carries both the challenge id and a random value. That is what
      // makes the code useless in a browser that did not ask for it.
      const browserBinding =
        input.method === 'email_code' ? `${challengeId}.${generateToken()}` : null;

      const ttlMs = input.method === 'magic_link' ? policy.magicLinkTtlMs : policy.emailCodeTtlMs;
      const expiresAt = new Date(now.getTime() + ttlMs);

      // Carried forward, because section 20 retains attempt pressure across
      // resends and a resend that reset the count would be a way around it.
      const resendCount = live === undefined ? 0 : live.resendCount + 1;

      await db.insert(loginChallenges).values({
        id: challengeId,
        userId: user?.id ?? null,
        emailFingerprint: fingerprint,
        method: input.method,
        purpose,
        secretHash: hasher.hash(secretDomain(input.method), secret, challengeId),
        browserBindingHash:
          browserBinding === null
            ? null
            : hasher.hash('browser_binding', browserBinding, challengeId),
        createdAt: now,
        lastSentAt: now,
        expiresAt,
        maxAttempts: policy.maxAttempts,
        resendCount,
        redirectPath: input.redirectPath ?? null,
        requestIp: input.requestIp ?? null,
        requestUserAgent: input.requestUserAgent ?? null,
      });

      return {
        outcome: 'issued',
        challengeId,
        secret,
        expiresAt,
        browserBinding,
        recipientExists: user !== undefined,
        resendCount,
      };
    },

    async verify(db, presented, options = {}) {
      const now = options.now ?? new Date();
      const trimmed = presented.trim();

      // A magic-link token carries its own challenge id; a code does not, so
      // the browser-binding cookie carries it. Either way the id is not a
      // secret: it locates the row, and the secret is what proves anything.
      const identified = identify(trimmed, options.browserBinding);

      if (identified === null) {
        return { outcome: 'invalid' };
      }

      const [challenge] = await db
        .select()
        .from(loginChallenges)
        .where(eq(loginChallenges.id, identified.challengeId));

      if (challenge === undefined) {
        return { outcome: 'invalid' };
      }

      if (challenge.consumedAt !== null || challenge.supersededAt !== null) {
        return { outcome: 'invalid' };
      }

      if (challenge.expiresAt.getTime() <= now.getTime()) {
        return { outcome: 'expired' };
      }

      if (challenge.attempts >= challenge.maxAttempts) {
        return { outcome: 'exhausted' };
      }

      if (challenge.browserBindingHash !== null) {
        const binding = options.browserBinding;
        const matches =
          binding !== undefined &&
          hasher.verify('browser_binding', binding, challenge.browserBindingHash, challenge.id);

        if (!matches) {
          // Counted, so an attacker who has the digits but not the browser
          // cannot try indefinitely in the hope of a race.
          await countAttempt(db, challenge.id);
          return { outcome: 'wrong_browser' };
        }
      }

      const correct = hasher.verify(
        secretDomain(challenge.method),
        identified.secret,
        challenge.secretHash,
        challenge.id,
      );

      if (!correct) {
        const attempts = await countAttempt(db, challenge.id);

        return attempts >= challenge.maxAttempts
          ? { outcome: 'exhausted' }
          : { outcome: 'invalid' };
      }

      if (challenge.userId === null) {
        // A real challenge for an address with no account. Reaching this means
        // the request came from whoever received the message, which is nobody:
        // no message was sent. It is recorded and refused.
        return { outcome: 'no_account' };
      }

      // Single use, enforced atomically. Two requests arriving with the same
      // valid token both reach this line; the UPDATE's own WHERE clause is what
      // makes exactly one of them win.
      const [consumed] = await db
        .update(loginChallenges)
        .set({ consumedAt: now })
        .where(and(eq(loginChallenges.id, challenge.id), isNull(loginChallenges.consumedAt)))
        .returning();

      if (consumed === undefined) {
        return { outcome: 'invalid' };
      }

      return { outcome: 'verified', challenge: consumed, userId: challenge.userId };
    },

    async supersedeLive(db, email, purpose = 'login', now = new Date()) {
      // Section 20: a new challenge invalidates older unused email challenges
      // for the same login context. Also what keeps the partial unique index on
      // live challenges satisfiable.
      const superseded = await db
        .update(loginChallenges)
        .set({ supersededAt: now })
        .where(
          and(
            eq(loginChallenges.emailFingerprint, fingerprintOf(email)),
            eq(loginChallenges.purpose, purpose),
            isNull(loginChallenges.consumedAt),
            isNull(loginChallenges.supersededAt),
          ),
        )
        .returning({ id: loginChallenges.id });

      return superseded.length;
    },

    async pruneFinished(db, now = new Date()) {
      const cutoff = new Date(now.getTime() - policy.retentionMs);

      const removed = await db
        .delete(loginChallenges)
        .where(lt(loginChallenges.createdAt, cutoff))
        .returning({ id: loginChallenges.id });

      return removed.length;
    },
  };
}

interface IdentifiedChallenge {
  readonly challengeId: string;
  readonly secret: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Works out which challenge a presented value belongs to.
 *
 * A magic-link token is `<challenge id>.<random>`, so a single primary-key
 * lookup finds the row and the stored hash stays bound to it. A code carries no
 * id, so the browser-binding cookie supplies one — which is also what makes the
 * code useless in another browser.
 *
 * The secret is always the whole presented value, including the id prefix on a
 * link. Hashing only the random half would mean the same random half was valid
 * under any challenge id, which is the property the binding exists to prevent.
 */
function identify(presented: string, browserBinding?: string): IdentifiedChallenge | null {
  const separator = presented.indexOf('.');

  if (separator > 0) {
    const challengeId = presented.slice(0, separator);

    if (UUID_PATTERN.test(challengeId) && presented.length > separator + 1) {
      return { challengeId, secret: presented };
    }
  }

  if (browserBinding === undefined) {
    return null;
  }

  const challengeId = challengeIdFromBinding(browserBinding);

  return challengeId === null ? null : { challengeId, secret: presented };
}

/**
 * Extracts the challenge id a browser-binding cookie refers to.
 *
 * The web tier needs it to clear the cookie once the challenge is finished, and
 * should not be parsing the format by hand to do that.
 */
export function challengeIdFromBinding(binding: string): string | null {
  const challengeId = binding.slice(0, Math.max(binding.indexOf('.'), 0));

  return UUID_PATTERN.test(challengeId) ? challengeId : null;
}

/**
 * Records one failed attempt and returns the new total.
 *
 * A single statement, so two wrong guesses arriving together cannot both read
 * the same count and write the same increment.
 */
async function countAttempt(db: ChallengeWriter, challengeId: string): Promise<number> {
  const [row] = await db
    .update(loginChallenges)
    .set({ attempts: sql`${loginChallenges.attempts} + 1` })
    .where(
      and(
        eq(loginChallenges.id, challengeId),
        sql`${loginChallenges.attempts} < ${loginChallenges.maxAttempts}`,
      ),
    )
    .returning({ attempts: loginChallenges.attempts });

  return row?.attempts ?? Number.MAX_SAFE_INTEGER;
}
