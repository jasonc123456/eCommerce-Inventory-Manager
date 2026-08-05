import { randomUUID } from 'node:crypto';

import type { KeyedHasher } from '@eim/crypto';
import {
  webauthnChallenges,
  webauthnCredentials,
  type Database,
  type WebauthnCredential,
} from '@eim/db';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';

/**
 * Passkeys (section 20).
 *
 * The WebAuthn ceremony itself is delegated to `@simplewebauthn/server`.
 * Attestation parsing, COSE key decoding, and assertion signature verification
 * are specification surface with sharp edges, and a hand-rolled version of them
 * is the kind of code that looks right and accepts a forged assertion. Every
 * policy decision around the ceremony is here: what a challenge is worth, how
 * long it lives, what a counter regression means, and who may remove a
 * credential.
 *
 * The challenge is stored as a keyed hash. Section 19 forbids logging a WebAuthn
 * challenge, and a readable column would put it in every dump and backup
 * instead. Verification therefore compares by hash rather than by value, which
 * `@simplewebauthn/server` supports through a predicate.
 */

export interface RelyingParty {
  /** Section 20: a stable id from the canonical deployment hostname. */
  readonly id: string;
  readonly name: string;
  /** Exact origins that may complete a ceremony. Nothing else is accepted. */
  readonly allowedOrigins: readonly string[];
}

/** Section 20 keeps a WebAuthn challenge bounded and short-lived. */
const CHALLENGE_TTL_MS = 5 * 60_000;

export type PasskeyWriter = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

export type RegistrationResult =
  | { readonly outcome: 'registered'; readonly credentialId: string }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'already_registered' };

export type AuthenticationResult =
  | {
      readonly outcome: 'authenticated';
      readonly userId: string;
      readonly credentialId: string;
      /**
       * Section 20 treats a non-increasing counter as a signal rather than
       * proof, because synced credentials legitimately report zero forever. The
       * caller records it and does not refuse on it alone.
       */
      readonly counterRegressed: boolean;
    }
  | { readonly outcome: 'invalid' };

export interface PasskeyService {
  beginRegistration(
    db: PasskeyWriter,
    input: { readonly userId: string; readonly userName: string; readonly displayName?: string },
    now?: Date,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }>;
  finishRegistration(
    db: PasskeyWriter,
    input: {
      readonly userId: string;
      readonly challengeId: string;
      readonly response: RegistrationResponseJSON;
      readonly name: string;
    },
    now?: Date,
  ): Promise<RegistrationResult>;
  beginAuthentication(
    db: PasskeyWriter,
    options?: { readonly userId?: string; readonly now?: Date },
  ): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>;
  finishAuthentication(
    db: PasskeyWriter,
    input: { readonly challengeId: string; readonly response: AuthenticationResponseJSON },
    now?: Date,
  ): Promise<AuthenticationResult>;
  list(db: PasskeyWriter, userId: string): Promise<WebauthnCredential[]>;
  rename(db: PasskeyWriter, userId: string, credentialId: string, name: string): Promise<boolean>;
  remove(db: PasskeyWriter, userId: string, credentialId: string): Promise<boolean>;
  countFor(db: PasskeyWriter, userId: string): Promise<number>;
  pruneExpiredChallenges(db: PasskeyWriter, now?: Date): Promise<number>;
}

type PublicKeyCredentialCreationOptionsJSON = Awaited<
  ReturnType<typeof generateRegistrationOptions>
>;
type PublicKeyCredentialRequestOptionsJSON = Awaited<
  ReturnType<typeof generateAuthenticationOptions>
>;

export function createPasskeyService(
  hasher: KeyedHasher,
  relyingParty: RelyingParty,
): PasskeyService {
  const storeChallenge = async (
    db: PasskeyWriter,
    challenge: string,
    kind: 'registration' | 'authentication',
    userId: string | null,
    now: Date,
  ): Promise<string> => {
    const challengeId = randomUUID();

    await db.insert(webauthnChallenges).values({
      id: challengeId,
      userId,
      challengeHash: hasher.hash('passkey_challenge', challenge, challengeId),
      kind,
      createdAt: now,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    });

    return challengeId;
  };

  /**
   * Consumes a challenge, or refuses.
   *
   * Conditional on it being unused, so two responses to the same ceremony
   * cannot both be accepted, and so a replayed assertion has nothing to verify
   * against.
   */
  const consumeChallenge = async (
    db: PasskeyWriter,
    challengeId: string,
    kind: 'registration' | 'authentication',
    now: Date,
  ): Promise<{ challengeHash: string; userId: string | null } | null> => {
    const [consumed] = await db
      .update(webauthnChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(webauthnChallenges.id, challengeId),
          eq(webauthnChallenges.kind, kind),
          isNull(webauthnChallenges.consumedAt),
          sql`${webauthnChallenges.expiresAt} > ${now}`,
        ),
      )
      .returning({
        challengeHash: webauthnChallenges.challengeHash,
        userId: webauthnChallenges.userId,
      });

    return consumed ?? null;
  };

  const matchesStoredChallenge =
    (challengeId: string, storedHash: string) =>
    (presented: string): boolean =>
      hasher.verify('passkey_challenge', presented, storedHash, challengeId);

  return {
    async beginRegistration(db, input, now = new Date()) {
      const existing = await db
        .select({ credentialId: webauthnCredentials.credentialId })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, input.userId));

      const options = await generateRegistrationOptions({
        rpID: relyingParty.id,
        rpName: relyingParty.name,
        userName: input.userName,
        userDisplayName: input.displayName ?? input.userName,
        // Section 20 requires user verification and explicit intent, and
        // discoverable credentials are what make a username-less sign-in work.
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'required',
        },
        // Both platform and roaming authenticators (section 20), so no
        // `authenticatorAttachment` is stated.
        excludeCredentials: existing.map((row) => ({ id: row.credentialId })),
        attestationType: 'none',
      });

      const challengeId = await storeChallenge(
        db,
        options.challenge,
        'registration',
        input.userId,
        now,
      );

      return { options, challengeId };
    },

    async finishRegistration(db, input, now = new Date()) {
      const consumed = await consumeChallenge(db, input.challengeId, 'registration', now);

      // A registration challenge belongs to the user it was issued for, so a
      // response answering somebody else's ceremony is refused rather than
      // registering an authenticator against the wrong account.
      if (consumed?.userId !== input.userId) {
        return { outcome: 'invalid' };
      }

      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;

      try {
        verification = await verifyRegistrationResponse({
          response: input.response,
          expectedChallenge: matchesStoredChallenge(input.challengeId, consumed.challengeHash),
          expectedOrigin: [...relyingParty.allowedOrigins],
          expectedRPID: relyingParty.id,
          requireUserVerification: true,
        });
      } catch {
        // A malformed or hostile response. The library throws rather than
        // returning false for these, and the caller's answer is the same.
        return { outcome: 'invalid' };
      }

      if (!verification.verified) {
        return { outcome: 'invalid' };
      }

      const { credential, aaguid, credentialBackedUp, credentialDeviceType } =
        verification.registrationInfo;

      const [existing] = await db
        .select({ id: webauthnCredentials.id })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.credentialId, credential.id));

      if (existing !== undefined) {
        return { outcome: 'already_registered' };
      }

      await db.insert(webauthnCredentials).values({
        userId: input.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        signCount: credential.counter,
        transports: credential.transports ?? [],
        backupEligible: credentialDeviceType === 'multiDevice',
        backupState: credentialBackedUp,
        aaguid: /^[0-9a-f-]{36}$/i.test(aaguid) ? aaguid : null,
        name: input.name,
        createdAt: now,
      });

      return { outcome: 'registered', credentialId: credential.id };
    },

    async beginAuthentication(db, options = {}) {
      const now = options.now ?? new Date();

      // No allowCredentials when the user is unknown. A discoverable-credential
      // sign-in has to work before anybody has said who they are, and listing
      // credentials for a named user would answer "does this account exist" to
      // an unauthenticated caller.
      const allowCredentials =
        options.userId === undefined
          ? undefined
          : (
              await db
                .select({
                  credentialId: webauthnCredentials.credentialId,
                  transports: webauthnCredentials.transports,
                })
                .from(webauthnCredentials)
                .where(eq(webauthnCredentials.userId, options.userId))
            ).map((row) => ({ id: row.credentialId }));

      const generated = await generateAuthenticationOptions({
        rpID: relyingParty.id,
        userVerification: 'required',
        ...(allowCredentials === undefined ? {} : { allowCredentials }),
      });

      const challengeId = await storeChallenge(
        db,
        generated.challenge,
        'authentication',
        options.userId ?? null,
        now,
      );

      return { options: generated, challengeId };
    },

    async finishAuthentication(db, input, now = new Date()) {
      const consumed = await consumeChallenge(db, input.challengeId, 'authentication', now);

      if (consumed === null) {
        return { outcome: 'invalid' };
      }

      const [credential] = await db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.credentialId, input.response.id));

      if (credential === undefined) {
        return { outcome: 'invalid' };
      }

      // A challenge issued for a named user must not be answered by somebody
      // else's authenticator.
      if (consumed.userId !== null && consumed.userId !== credential.userId) {
        return { outcome: 'invalid' };
      }

      let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;

      try {
        verification = await verifyAuthenticationResponse({
          response: input.response,
          expectedChallenge: matchesStoredChallenge(input.challengeId, consumed.challengeHash),
          expectedOrigin: [...relyingParty.allowedOrigins],
          expectedRPID: relyingParty.id,
          requireUserVerification: true,
          credential: {
            id: credential.credentialId,
            publicKey: new Uint8Array(credential.publicKey),
            counter: credential.signCount,
            transports: credential.transports as never,
          },
        });
      } catch {
        return { outcome: 'invalid' };
      }

      if (!verification.verified) {
        return { outcome: 'invalid' };
      }

      const { newCounter } = verification.authenticationInfo;

      // Zero on both sides is the normal state for a synced passkey, not a
      // regression: those authenticators do not maintain a counter at all.
      const counterRegressed =
        credential.signCount > 0 && newCounter > 0 && newCounter <= credential.signCount;

      await db
        .update(webauthnCredentials)
        .set({ signCount: newCounter, lastUsedAt: now })
        .where(eq(webauthnCredentials.id, credential.id));

      return {
        outcome: 'authenticated',
        userId: credential.userId,
        credentialId: credential.credentialId,
        counterRegressed,
      };
    },

    async list(db, userId) {
      return await db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId))
        .orderBy(webauthnCredentials.createdAt);
    },

    async rename(db, userId, credentialId, name) {
      if (name.trim().length === 0) {
        return false;
      }

      // Scoped to the owner. Section 20: only the user may register, rename, or
      // remove their passkeys, and an administrator cannot replace another
      // user's authenticator.
      const renamed = await db
        .update(webauthnCredentials)
        .set({ name })
        .where(
          and(
            eq(webauthnCredentials.credentialId, credentialId),
            eq(webauthnCredentials.userId, userId),
          ),
        )
        .returning({ id: webauthnCredentials.id });

      return renamed.length > 0;
    },

    async remove(db, userId, credentialId) {
      const removed = await db
        .delete(webauthnCredentials)
        .where(
          and(
            eq(webauthnCredentials.credentialId, credentialId),
            eq(webauthnCredentials.userId, userId),
          ),
        )
        .returning({ id: webauthnCredentials.id });

      return removed.length > 0;
    },

    async countFor(db, userId) {
      const rows = await db
        .select({ id: webauthnCredentials.id })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId));

      return rows.length;
    },

    async pruneExpiredChallenges(db, now = new Date()) {
      const removed = await db
        .delete(webauthnChallenges)
        .where(lte(webauthnChallenges.expiresAt, now))
        .returning({ id: webauthnChallenges.id });

      return removed.length;
    },
  };
}
