import { generateToken, type KeyedHasher } from '@eim/crypto';
import { connectionAuthorizations, type Database } from '@eim/db';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';

/**
 * The single-use state carried through a provider's consent screen
 * (sections 13, 14).
 *
 * The value handed to the provider is `<id>.<secret>`. The id makes the lookup
 * a primary-key read rather than a scan, and the secret is what proves the
 * caller is the browser we sent. Both halves are hashed together, so the secret
 * is not valid under any other id — the same rule the email challenges follow,
 * and for the same reason.
 *
 * Three properties, each of which is a real attack if missing:
 *
 *   Single use. A callback URL lives in browser history and in the provider's
 *   referrer logs. Replaying it must not re-link the connection.
 *
 *   Bound to a business and a user. Without the binding, a state issued for one
 *   business could be returned to a session in another, and the connection —
 *   with its seller's catalog and orders — would be created there.
 *
 *   Short-lived. Consent takes a minute; anything left pending for an hour is
 *   an abandoned tab, and an abandoned tab that is still valid tomorrow is a
 *   credential nobody is watching.
 */

const DEFAULT_TTL_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BeginAuthorization {
  readonly businessId: string;
  readonly provider: 'ebay' | 'woocommerce';
  readonly environment: 'sandbox' | 'production';
  readonly initiatedByUserId: string;
  /** Set when reauthorizing an existing connection rather than adding one. */
  readonly connectionId?: string | undefined;
  /** WooCommerce only: the normalized store origin this callback must come from. */
  readonly storeOrigin?: string | undefined;
  readonly redirectPath?: string;
  readonly now?: Date | undefined;
  readonly ttlMs?: number;
}

export interface PendingAuthorization {
  readonly id: string;
  readonly businessId: string;
  readonly provider: 'ebay' | 'woocommerce';
  readonly environment: 'sandbox' | 'production';
  readonly connectionId: string | null;
  readonly initiatedByUserId: string;
  readonly storeOrigin: string | null;
  readonly redirectPath: string;
}

export type ConsumeResult =
  | { readonly ok: true; readonly authorization: PendingAuthorization }
  | { readonly ok: false; readonly reason: ConsumeFailure };

export type ConsumeFailure = 'malformed' | 'unknown' | 'expired' | 'already_used' | 'wrong_store';

export interface Authorizations {
  /** Issues a state value. Returns it once; it is not recoverable afterwards. */
  begin(input: BeginAuthorization): Promise<{ state: string; id: string }>;
  /** Spends a state value, or explains why it cannot be spent. */
  consume(input: ConsumeAuthorization): Promise<ConsumeResult>;
  /** Removes expired unconsumed rows. Housekeeping, not security. */
  pruneExpired(now?: Date): Promise<number>;
}

export interface ConsumeAuthorization {
  readonly state: string;
  /** WooCommerce only: the store the callback claims to be from. */
  readonly storeOrigin?: string | undefined;
  readonly now?: Date | undefined;
}

export interface AuthorizationOptions {
  readonly db: Database;
  readonly hasher: KeyedHasher;
}

export function createAuthorizations(options: AuthorizationOptions): Authorizations {
  const { db, hasher } = options;

  return {
    async begin(input) {
      const now = input.now ?? new Date();
      const secret = generateToken();

      return db.transaction(async (tx) => {
        // Supersede whatever was pending for this business, provider, and
        // environment. Two tabs part-way through connecting the same account
        // otherwise produce two codes, one of which fails with an error nobody
        // can explain; the newest attempt is the one the operator is looking at.
        await tx
          .delete(connectionAuthorizations)
          .where(
            and(
              eq(connectionAuthorizations.businessId, input.businessId),
              eq(connectionAuthorizations.provider, input.provider),
              eq(connectionAuthorizations.environment, input.environment),
              isNull(connectionAuthorizations.consumedAt),
            ),
          );

        const [row] = await tx
          .insert(connectionAuthorizations)
          .values({
            businessId: input.businessId,
            provider: input.provider,
            environment: input.environment,
            connectionId: input.connectionId ?? null,
            initiatedByUserId: input.initiatedByUserId,
            // Placeholder: the hash binds the row id, which does not exist
            // until the row does. Replaced below, in the same transaction, so
            // no other statement can observe it.
            stateHash: `pending:${secret}`,
            storeOrigin: input.storeOrigin ?? null,
            redirectPath: input.redirectPath ?? '/connections',
            expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)),
          })
          .returning({ id: connectionAuthorizations.id });

        if (row === undefined) {
          // An insert with no returned row means the statement did not do what
          // it said. Failing here beats handing back a state value that names
          // an authorization which may not exist.
          throw new Error('the authorization could not be recorded');
        }

        const state = `${row.id}.${secret}`;

        await tx
          .update(connectionAuthorizations)
          .set({ stateHash: hasher.hash('connection_authorization', state, row.id) })
          .where(eq(connectionAuthorizations.id, row.id));

        return { state, id: row.id };
      });
    },

    async consume(input) {
      const now = input.now ?? new Date();
      const separator = input.state.indexOf('.');

      if (separator <= 0) {
        return { ok: false, reason: 'malformed' };
      }

      const id = input.state.slice(0, separator);

      if (!UUID.test(id)) {
        return { ok: false, reason: 'malformed' };
      }

      const [row] = await db
        .select()
        .from(connectionAuthorizations)
        .where(eq(connectionAuthorizations.id, id))
        .limit(1);

      // The hash is verified even when no row was found, so that a state naming
      // a nonexistent authorization takes the same path as one naming a real
      // authorization with the wrong secret.
      const expected = row?.stateHash ?? hasher.hash('connection_authorization', 'absent', id);
      const matches = hasher.verify('connection_authorization', input.state, expected, id);

      if (row === undefined || !matches) {
        return { ok: false, reason: 'unknown' };
      }

      if (row.consumedAt !== null) {
        return { ok: false, reason: 'already_used' };
      }

      if (row.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired' };
      }

      // WooCommerce's callback has to come back from the store the operator
      // typed. A callback from a different store carrying a valid state is
      // either a misconfiguration or somebody else's store trying to be added.
      if (row.storeOrigin !== null && row.storeOrigin !== input.storeOrigin) {
        return { ok: false, reason: 'wrong_store' };
      }

      // Conditional on still being unconsumed, so two callbacks arriving at
      // once cannot both succeed. The database decides which one, and the loser
      // is told the state was already used rather than being handed a second
      // authorization.
      const spent = await db
        .update(connectionAuthorizations)
        .set({ consumedAt: now })
        .where(
          and(eq(connectionAuthorizations.id, row.id), isNull(connectionAuthorizations.consumedAt)),
        )
        .returning({ id: connectionAuthorizations.id });

      if (spent.length === 0) {
        return { ok: false, reason: 'already_used' };
      }

      return {
        ok: true,
        authorization: {
          id: row.id,
          businessId: row.businessId,
          provider: row.provider,
          environment: row.environment,
          connectionId: row.connectionId,
          initiatedByUserId: row.initiatedByUserId,
          storeOrigin: row.storeOrigin,
          redirectPath: row.redirectPath,
        },
      };
    },

    async pruneExpired(now = new Date()) {
      const removed = await db
        .delete(connectionAuthorizations)
        .where(
          and(
            lt(connectionAuthorizations.expiresAt, now),
            isNull(connectionAuthorizations.consumedAt),
          ),
        )
        .returning({ id: connectionAuthorizations.id });

      return removed.length;
    },
  };
}

/** Whether any authorization is currently in flight, for the interface. */
export async function pendingFor(
  db: Database,
  businessId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .select({ id: connectionAuthorizations.id })
    .from(connectionAuthorizations)
    .where(
      and(
        eq(connectionAuthorizations.businessId, businessId),
        isNull(connectionAuthorizations.consumedAt),
        gt(connectionAuthorizations.expiresAt, now),
      ),
    );

  return rows.length;
}
