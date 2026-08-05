import { randomUUID } from 'node:crypto';

import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateToken,
  normalizeRecoveryCode,
  type Keyring,
  type KeyedHasher,
  type SecretContext,
} from '@eim/crypto';
import { recoveryCodes, totpCredentials, trustedDevices, type Database } from '@eim/db';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';

/**
 * Second factors: TOTP, recovery codes, and trusted devices (section 20).
 *
 * Section 20's rule that shapes this file is "two email messages to the same
 * inbox never count as two factors". Everything here is therefore something the
 * inbox does not give you: an authenticator's shared secret, a code written down
 * at enrollment, or a device the user already proved themselves on.
 *
 * The TOTP seed is encrypted with the installation keyring, so a database copy
 * without the `.env` cannot generate codes. The recovery codes are keyed hashes
 * bound to the user, so the same copy cannot test them either.
 */

/** Section 20: six digits, thirty-second steps, plus or minus one step. */
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_WINDOW = 1;

/** Section 20: a trusted device lasts thirty days. */
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60_000;

/** Section 20: ten codes, shown once. */
const RECOVERY_CODE_COUNT = 10;

export type TwoFactorWriter = Pick<Database, 'insert' | 'update' | 'select' | 'delete'>;

function seedContext(userId: string): SecretContext {
  return { businessId: null, resource: `user:${userId}`, secretType: 'totp_seed' };
}

export interface TotpEnrollment {
  /**
   * The `otpauth://` URI the authenticator scans, and the same secret in the
   * form a user types when a camera is not available (section 20).
   */
  readonly otpauthUri: string;
  readonly manualEntryKey: string;
}

export type TotpVerification =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'rejected' }
  /** The same code again inside its own ninety-second validity window. */
  | { readonly outcome: 'replayed' }
  | { readonly outcome: 'not_enrolled' };

export type DisableTwoFactorResult =
  | { readonly outcome: 'disabled' }
  /** Section 20: disabling needs a current second factor or a recovery code. */
  | { readonly outcome: 'proof_required' };

export interface TwoFactorService {
  beginTotpEnrollment(
    db: TwoFactorWriter,
    input: { readonly userId: string; readonly accountLabel: string; readonly issuer: string },
    now?: Date,
  ): Promise<TotpEnrollment>;
  activateTotp(
    db: TwoFactorWriter,
    userId: string,
    code: string,
    now?: Date,
  ): Promise<TotpVerification>;
  verifyTotp(
    db: TwoFactorWriter,
    userId: string,
    code: string,
    now?: Date,
  ): Promise<TotpVerification>;
  isTotpActive(db: TwoFactorWriter, userId: string): Promise<boolean>;
  disableTotp(db: Database, userId: string): Promise<void>;

  issueRecoveryCodes(db: Database, userId: string, now?: Date): Promise<readonly string[]>;
  consumeRecoveryCode(
    db: TwoFactorWriter,
    userId: string,
    code: string,
    now?: Date,
  ): Promise<boolean>;
  countRemainingRecoveryCodes(db: TwoFactorWriter, userId: string): Promise<number>;

  trustDevice(
    db: TwoFactorWriter,
    input: { readonly userId: string; readonly label?: string },
    now?: Date,
  ): Promise<{ token: string; expiresAt: Date }>;
  isDeviceTrusted(db: TwoFactorWriter, userId: string, token: string, now?: Date): Promise<boolean>;
  revokeTrustedDevices(db: TwoFactorWriter, userId: string, now?: Date): Promise<number>;
  pruneExpiredTrustedDevices(db: TwoFactorWriter, now?: Date): Promise<number>;
}

export function createTwoFactorService(hasher: KeyedHasher, keyring: Keyring): TwoFactorService {
  const totpFor = (secret: string, label: string, issuer: string): TOTP =>
    new TOTP({
      issuer,
      label,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      secret: Secret.fromBase32(secret),
    });

  /** The step number a moment falls in, used to make a code single-use. */
  const stepAt = (now: Date): number => Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);

  const check = async (
    db: TwoFactorWriter,
    userId: string,
    code: string,
    now: Date,
    requireActive: boolean,
  ): Promise<TotpVerification> => {
    const [credential] = await db
      .select()
      .from(totpCredentials)
      .where(eq(totpCredentials.userId, userId));

    if (credential === undefined) {
      return { outcome: 'not_enrolled' };
    }

    if (requireActive && credential.status !== 'active') {
      return { outcome: 'not_enrolled' };
    }

    const seed = decryptSecret(keyring, seedContext(userId), credential.encryptedSeed);
    const totp = totpFor(seed, 'account', 'issuer');

    // The timestamp is passed explicitly rather than left to default to the
    // real clock. Without it the code is checked against whenever the process
    // happens to be running, which makes the whole thing untestable and would
    // silently ignore any caller that needed to reason about a specific moment.
    const delta = totp.validate({
      token: code.replace(/\s/g, ''),
      timestamp: now.getTime(),
      window: TOTP_WINDOW,
    });

    if (delta === null) {
      return { outcome: 'rejected' };
    }

    const usedStep = stepAt(now) + delta;

    // Section 20's plus-or-minus-one window means a code stays valid for ninety
    // seconds, and without this it would be reusable for most of that. Recording
    // the step is what makes it single-use.
    if (credential.lastUsedStep !== null && usedStep <= credential.lastUsedStep) {
      return { outcome: 'replayed' };
    }

    // Conditional on the step still being what was read, so two requests with
    // the same code cannot both pass.
    const [updated] = await db
      .update(totpCredentials)
      .set({ lastUsedStep: usedStep })
      .where(
        and(
          eq(totpCredentials.userId, userId),
          credential.lastUsedStep === null
            ? isNull(totpCredentials.lastUsedStep)
            : eq(totpCredentials.lastUsedStep, credential.lastUsedStep),
        ),
      )
      .returning({ userId: totpCredentials.userId });

    return updated === undefined ? { outcome: 'replayed' } : { outcome: 'accepted' };
  };

  return {
    async beginTotpEnrollment(db, input, now = new Date()) {
      const secret = new Secret({ size: 20 });
      const totp = totpFor(secret.base32, input.accountLabel, input.issuer);

      // Written as `pending`, so an enrollment abandoned halfway leaves an
      // inactive row rather than a second factor the user cannot satisfy.
      // Section 20 requires successful verification before activation.
      await db
        .insert(totpCredentials)
        .values({
          userId: input.userId,
          encryptedSeed: encryptSecret(keyring, seedContext(input.userId), secret.base32),
          status: 'pending',
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: totpCredentials.userId,
          set: {
            encryptedSeed: encryptSecret(keyring, seedContext(input.userId), secret.base32),
            status: 'pending',
            activatedAt: null,
            lastUsedStep: null,
            createdAt: now,
          },
        });

      return { otpauthUri: totp.toString(), manualEntryKey: secret.base32 };
    },

    async activateTotp(db, userId, code, now = new Date()) {
      const result = await check(db, userId, code, now, false);

      if (result.outcome !== 'accepted') {
        return result;
      }

      await db
        .update(totpCredentials)
        .set({ status: 'active', activatedAt: now })
        .where(eq(totpCredentials.userId, userId));

      return { outcome: 'accepted' };
    },

    async verifyTotp(db, userId, code, now = new Date()) {
      return await check(db, userId, code, now, true);
    },

    async isTotpActive(db, userId) {
      const [row] = await db
        .select({ status: totpCredentials.status })
        .from(totpCredentials)
        .where(eq(totpCredentials.userId, userId));

      return row?.status === 'active';
    },

    async disableTotp(db, userId) {
      // Section 20: disabling revokes the recovery and trusted-device records
      // with it, because both exist to work around the factor being removed.
      await db.transaction(async (tx) => {
        await tx.delete(totpCredentials).where(eq(totpCredentials.userId, userId));
        await tx
          .update(recoveryCodes)
          .set({ invalidatedAt: new Date() })
          .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.consumedAt)));
        await tx
          .update(trustedDevices)
          .set({ revokedAt: new Date() })
          .where(and(eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)));
      });
    },

    async issueRecoveryCodes(db, userId, now = new Date()) {
      const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
      const batchId = randomUUID();

      await db.transaction(async (tx) => {
        // Section 20 invalidates the previous set on regeneration. Marked rather
        // than deleted, so "you regenerated these on the 5th" survives in the
        // record.
        await tx
          .update(recoveryCodes)
          .set({ invalidatedAt: now })
          .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.consumedAt)));

        await tx.insert(recoveryCodes).values(
          codes.map((code) => ({
            userId,
            codeHash: hasher.hash('recovery_code', normalizeRecoveryCode(code), userId),
            batchId,
            createdAt: now,
          })),
        );
      });

      // Returned once. Nothing stores them, and the caller shows them and
      // forgets them.
      return codes;
    },

    async consumeRecoveryCode(db, userId, code, now = new Date()) {
      const codeHash = hasher.hash('recovery_code', normalizeRecoveryCode(code), userId);

      // One statement, conditional on the code being unused, so the same code
      // presented twice at once is spent once.
      const consumed = await db
        .update(recoveryCodes)
        .set({ consumedAt: now })
        .where(
          and(
            eq(recoveryCodes.userId, userId),
            eq(recoveryCodes.codeHash, codeHash),
            isNull(recoveryCodes.consumedAt),
            isNull(recoveryCodes.invalidatedAt),
          ),
        )
        .returning({ id: recoveryCodes.id });

      return consumed.length > 0;
    },

    async countRemainingRecoveryCodes(db, userId) {
      const rows = await db
        .select({ id: recoveryCodes.id })
        .from(recoveryCodes)
        .where(
          and(
            eq(recoveryCodes.userId, userId),
            isNull(recoveryCodes.consumedAt),
            isNull(recoveryCodes.invalidatedAt),
          ),
        );

      return rows.length;
    },

    async trustDevice(db, input, now = new Date()) {
      const token = generateToken();
      const expiresAt = new Date(now.getTime() + TRUSTED_DEVICE_TTL_MS);

      await db.insert(trustedDevices).values({
        userId: input.userId,
        tokenHash: hasher.hash('trusted_device', token, input.userId),
        label: input.label ?? null,
        createdAt: now,
        expiresAt,
      });

      return { token, expiresAt };
    },

    async isDeviceTrusted(db, userId, token, now = new Date()) {
      const [row] = await db
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(
          and(
            eq(trustedDevices.userId, userId),
            eq(trustedDevices.tokenHash, hasher.hash('trusted_device', token, userId)),
            isNull(trustedDevices.revokedAt),
            sql`${trustedDevices.expiresAt} > ${now}`,
          ),
        );

      if (row === undefined) {
        return false;
      }

      await db.update(trustedDevices).set({ lastUsedAt: now }).where(eq(trustedDevices.id, row.id));

      return true;
    },

    async revokeTrustedDevices(db, userId, now = new Date()) {
      const revoked = await db
        .update(trustedDevices)
        .set({ revokedAt: now })
        .where(and(eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)))
        .returning({ id: trustedDevices.id });

      return revoked.length;
    },

    async pruneExpiredTrustedDevices(db, now = new Date()) {
      const removed = await db
        .delete(trustedDevices)
        .where(lte(trustedDevices.expiresAt, now))
        .returning({ id: trustedDevices.id });

      return removed.length;
    },
  };
}

/**
 * Whether a second factor may be skipped for this request.
 *
 * Section 20: a trusted device lasts thirty days and "never bypasses
 * sensitive-action step-up". The two are separate questions and this function
 * answers only the first, so a caller that needs step-up cannot accidentally
 * satisfy it by asking about a trusted device.
 */
export function secondFactorSatisfied(input: {
  readonly totpActive: boolean;
  readonly deviceTrusted: boolean;
  readonly factorVerifiedThisRequest: boolean;
}): boolean {
  if (!input.totpActive) {
    return true;
  }

  return input.factorVerifiedThisRequest || input.deviceTrusted;
}
