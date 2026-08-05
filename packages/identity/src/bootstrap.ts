import { constantTimeEqual, generateToken, type KeyedHasher } from '@eim/crypto';
import {
  installationAdministratorPermissions,
  installationAdministrators,
  installationBootstrap,
  installationPermissions,
  users,
  type Database,
} from '@eim/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { normalizeEmail } from './challenges';

/**
 * Creating the first installation administrator (section 20).
 *
 * Two factors, because this is the one moment where a single mistake hands
 * somebody the whole installation. The configured address has to receive a
 * one-time link, and whoever opens it has to present the temporary setup secret
 * from the deployment host's `.env`. Possession of the inbox is not enough, and
 * neither is possession of the file.
 *
 * "Bootstrap endpoints disable permanently after successful creation" is
 * enforced by a row rather than by a flag in memory or a check for whether any
 * administrator exists. A restart, a redeploy, or an operator who forgot to
 * remove `EIM_SETUP_SECRET` must not reopen it, and "is the table empty" would
 * reopen it the moment the last administrator was removed — which is precisely
 * when an attacker would most like it to.
 */

export interface BootstrapStatus {
  readonly open: boolean;
  readonly completedAt: Date | null;
  readonly failedAttempts: number;
  readonly setupLinkOutstanding: boolean;
}

export type RequestSetupLinkResult =
  | { readonly outcome: 'issued'; readonly token: string; readonly expiresAt: Date }
  /**
   * Nothing was sent, and the caller must not say so.
   *
   * Returned both when the address does not match and when bootstrap has already
   * closed. Distinguishing them would tell an unauthenticated caller whether an
   * installation is claimed and what address claims it.
   */
  | { readonly outcome: 'ignored' };

export type CompleteBootstrapResult =
  | { readonly outcome: 'completed'; readonly userId: string }
  /** Wrong token, expired token, or wrong setup secret. Deliberately one case. */
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'already_completed' };

export interface BootstrapConfig {
  /** `EIM_INITIAL_ADMIN_EMAIL`. Bootstrap is unavailable without it. */
  readonly initialAdminEmail?: string | undefined;
  /** `EIM_SETUP_SECRET`. Bootstrap is unavailable without it. */
  readonly setupSecret?: string | undefined;
}

/** Section 20 gives the setup link the same fifteen minutes as a magic link. */
const SETUP_TOKEN_TTL_MS = 15 * 60_000;

export type BootstrapWriter = Pick<Database, 'insert' | 'update' | 'select'>;

export interface BootstrapService {
  status(db: BootstrapWriter): Promise<BootstrapStatus>;
  requestSetupLink(db: BootstrapWriter, email: string, now?: Date): Promise<RequestSetupLinkResult>;
  complete(
    db: Database,
    input: { readonly token: string; readonly setupSecret: string; readonly displayName?: string },
    now?: Date,
  ): Promise<CompleteBootstrapResult>;
}

export function createBootstrapService(
  hasher: KeyedHasher,
  config: BootstrapConfig,
): BootstrapService {
  const configuredEmail =
    config.initialAdminEmail === undefined ? null : normalizeEmail(config.initialAdminEmail);

  return {
    async status(db) {
      const [row] = await db.select().from(installationBootstrap);

      return {
        open: row?.completedAt == null,
        completedAt: row?.completedAt ?? null,
        failedAttempts: row?.failedAttempts ?? 0,
        setupLinkOutstanding: row?.setupTokenHash != null,
      };
    },

    async requestSetupLink(db, email, now = new Date()) {
      const [row] = await db.select().from(installationBootstrap);

      if (row === undefined) {
        // The single row is seeded by migration 0003. Its absence means the
        // schema is not the one this build expects, and issuing a setup link
        // against an unknown state is not a recovery.
        return { outcome: 'ignored' };
      }

      if (row.completedAt !== null) {
        return { outcome: 'ignored' };
      }

      if (
        configuredEmail === null ||
        config.setupSecret === undefined ||
        normalizeEmail(email) !== configuredEmail
      ) {
        // Counted, and visible on the health surface. Repeated attempts against
        // a live setup secret is an attack in progress, not a confused operator.
        await db
          .update(installationBootstrap)
          .set({
            failedAttempts: sql`${installationBootstrap.failedAttempts} + 1`,
            lastAttemptAt: now,
          })
          .where(eq(installationBootstrap.id, true));

        return { outcome: 'ignored' };
      }

      const token = generateToken();
      const expiresAt = new Date(now.getTime() + SETUP_TOKEN_TTL_MS);

      // Replaces any outstanding link, so requesting a second one invalidates
      // the first exactly as a second sign-in challenge does.
      await db
        .update(installationBootstrap)
        .set({
          setupTokenHash: hasher.hash('setup_secret', token),
          setupTokenIssuedAt: now,
          setupTokenExpiresAt: expiresAt,
          lastAttemptAt: now,
        })
        .where(and(eq(installationBootstrap.id, true), isNull(installationBootstrap.completedAt)));

      return { outcome: 'issued', token, expiresAt };
    },

    async complete(db, input, now = new Date()) {
      const [row] = await db.select().from(installationBootstrap);

      if (row === undefined) {
        return { outcome: 'refused' };
      }

      if (row.completedAt !== null) {
        return { outcome: 'already_completed' };
      }

      const tokenValid =
        row.setupTokenHash !== null &&
        row.setupTokenExpiresAt !== null &&
        row.setupTokenExpiresAt.getTime() > now.getTime() &&
        hasher.verify('setup_secret', input.token, row.setupTokenHash);

      // Compared in constant time, and both factors are evaluated before either
      // is reported, so the response does not say which one was wrong.
      const secretValid =
        config.setupSecret !== undefined &&
        constantTimeEqual(input.setupSecret, config.setupSecret);

      if (!tokenValid || !secretValid || configuredEmail === null) {
        await db
          .update(installationBootstrap)
          .set({
            failedAttempts: sql`${installationBootstrap.failedAttempts} + 1`,
            lastAttemptAt: now,
          })
          .where(eq(installationBootstrap.id, true));

        return { outcome: 'refused' };
      }

      return await db.transaction(async (tx) => {
        // The guard that makes this safe against two callers arriving together.
        // Closing bootstrap is the first write and is conditional on it being
        // open, so the second transaction updates no rows and gives up.
        const closed = await tx
          .update(installationBootstrap)
          .set({
            completedAt: now,
            lastAttemptAt: now,
            setupTokenHash: null,
            setupTokenIssuedAt: null,
            setupTokenExpiresAt: null,
          })
          .where(and(eq(installationBootstrap.id, true), isNull(installationBootstrap.completedAt)))
          .returning({ id: installationBootstrap.id });

        if (closed.length === 0) {
          return { outcome: 'already_completed' };
        }

        const [user] = await tx
          .insert(users)
          .values({
            email: configuredEmail,
            emailDisplay: config.initialAdminEmail ?? configuredEmail,
            displayName: input.displayName ?? null,
          })
          .returning({ id: users.id });

        if (user === undefined) {
          throw new Error('the first administrator could not be created');
        }

        await tx.insert(installationAdministrators).values({ userId: user.id });

        // Every installation permission, because there is nobody to grant them
        // later and an administrator who cannot add another administrator has
        // locked the installation on its first day.
        await tx.insert(installationAdministratorPermissions).values(
          installationPermissions.map((permission) => ({
            userId: user.id,
            permission,
          })),
        );

        await tx
          .update(installationBootstrap)
          .set({ completedByUserId: user.id })
          .where(eq(installationBootstrap.id, true));

        return { outcome: 'completed', userId: user.id };
      });
    },
  };
}
