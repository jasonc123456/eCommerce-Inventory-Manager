import { generateToken, type KeyedHasher } from '@eim/crypto';
import {
  businessDeletionRequests,
  businesses,
  memberships,
  type BusinessDeletionRequest,
  type Database,
} from '@eim/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Deleting a business, with the owner asked twice (sections 5, 13, 19).
 *
 * The shape of this module is one decision: **a deletion is authorized twice,
 * over two channels, and the second time is what counts.**
 *
 * Asking in the browser proves somebody holds a session. Asking again by email
 * proves they hold the mailbox that session was created from, which is the
 * thing an attacker with a stolen cookie does not have. Both checks re-read the
 * membership from the database, so a former owner's link is worth nothing.
 *
 * Section 5 is why ownership is checked rather than the `delete_business`
 * permission. Owners hold every permission implicitly, so the permission alone
 * would also admit a manager somebody granted it to — and "only an owner can
 * delete the shop" is a rule about who you are, not about what you were given.
 *
 * What deletion does is D-056's answer, not a `drop`: soft-delete the records,
 * erase the secrets that no longer have a purpose, and keep the structural
 * evidence. Which means the irreversible half is the credentials. The rows can
 * in principle be recovered by somebody with database access; the eBay refresh
 * token cannot, and neither can the store key. That is the right way round —
 * the dangerous thing about a dead business is that its credentials are alive.
 */

/**
 * How long a confirmation link lives.
 *
 * One hour. The owner asked for this a moment ago and is waiting for the email;
 * a link that stays good for days is a link that outlives the intent that
 * created it, sitting in an inbox that may be read by somebody else. It is
 * re-requestable, so the cost of it being short is one more click.
 */
export const DELETION_CONFIRMATION_TTL_MS = 60 * 60_000;

export type RequestDeletionResult =
  | { readonly outcome: 'requested'; readonly token: string; readonly expiresAt: Date }
  | { readonly outcome: 'not_an_owner' }
  | { readonly outcome: 'name_mismatch' }
  | { readonly outcome: 'already_requested' }
  | { readonly outcome: 'unknown_business' };

export type ConfirmDeletionResult =
  | { readonly outcome: 'deleted'; readonly businessId: string; readonly secretsErased: number }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'settled' }
  | { readonly outcome: 'not_an_owner' };

export interface DeletionService {
  request(db: Database, input: RequestDeletionInput): Promise<RequestDeletionResult>;
  confirm(db: Database, input: ConfirmDeletionInput): Promise<ConfirmDeletionResult>;
  cancel(db: Database, businessId: string, actorUserId: string): Promise<boolean>;
  outstanding(db: Database, businessId: string): Promise<BusinessDeletionRequest | null>;
}

export interface RequestDeletionInput {
  readonly businessId: string;
  readonly actorUserId: string;
  /**
   * The business name, as the owner typed it.
   *
   * Guards against the mistake this application makes easy: every screen acts
   * on whichever business the switcher happens to be pointing at, so "delete"
   * on the wrong one is a click away. Typing the name is the one confirmation
   * that cannot be satisfied by muscle memory.
   */
  readonly typedName: string;
  readonly reason?: string;
  readonly now?: Date;
}

export interface ConfirmDeletionInput {
  readonly token: string;
  /** Who is clicking. Re-checked against the membership, never trusted. */
  readonly actorUserId: string;
  readonly now?: Date;
}

/** Whether this user is an owner of this business, right now. */
async function isOwner(db: Database, businessId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.businessId, businessId),
        eq(memberships.userId, userId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

export function createDeletionService(hasher: KeyedHasher): DeletionService {
  return {
    async request(db, input) {
      const now = input.now ?? new Date();

      const [business] = await db
        .select({ name: businesses.name })
        .from(businesses)
        .where(and(eq(businesses.id, input.businessId), isNull(businesses.deletedAt)))
        .limit(1);

      if (business === undefined) {
        return { outcome: 'unknown_business' };
      }

      if (!(await isOwner(db, input.businessId, input.actorUserId))) {
        return { outcome: 'not_an_owner' };
      }

      // Compared after trimming and case-folding. The point is to prove the
      // person read which business they are on, not to test their typing.
      if (input.typedName.trim().toLowerCase() !== business.name.trim().toLowerCase()) {
        return { outcome: 'name_mismatch' };
      }

      const token = generateToken();

      try {
        await db.insert(businessDeletionRequests).values({
          businessId: input.businessId,
          requestedByUserId: input.actorUserId,
          tokenHash: hasher.hash('business_deletion', token),
          expiresAt: new Date(now.getTime() + DELETION_CONFIRMATION_TTL_MS),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        });
      } catch {
        // The partial unique index refused a second outstanding request. Told
        // apart from a generic failure because the answer is different: cancel
        // the one you have, or wait for it to expire.
        return { outcome: 'already_requested' };
      }

      return {
        outcome: 'requested',
        token,
        expiresAt: new Date(now.getTime() + DELETION_CONFIRMATION_TTL_MS),
      };
    },

    async confirm(db, input) {
      const now = input.now ?? new Date();
      const tokenHash = hasher.hash('business_deletion', input.token);

      const [request] = await db
        .select()
        .from(businessDeletionRequests)
        .where(eq(businessDeletionRequests.tokenHash, tokenHash))
        .limit(1);

      if (request === undefined) {
        return { outcome: 'invalid' };
      }

      if (request.confirmedAt !== null || request.cancelledAt !== null) {
        return { outcome: 'settled' };
      }

      if (request.expiresAt.getTime() <= now.getTime()) {
        return { outcome: 'expired' };
      }

      // Re-authorized here, not merely at request time. An owner who was
      // demoted or removed in the intervening hour is holding a link that must
      // no longer work — which is the whole reason this is a second check
      // rather than a second click.
      if (!(await isOwner(db, request.businessId, input.actorUserId))) {
        return { outcome: 'not_an_owner' };
      }

      return db.transaction(async (tx) => {
        // Settle the request first, inside the transaction. If two clicks
        // arrive together the second finds nothing to update and stands down,
        // rather than both proceeding to erase the same secrets twice.
        const settled = await tx
          .update(businessDeletionRequests)
          .set({ confirmedAt: now, confirmedByUserId: input.actorUserId })
          .where(
            and(
              eq(businessDeletionRequests.id, request.id),
              isNull(businessDeletionRequests.confirmedAt),
              isNull(businessDeletionRequests.cancelledAt),
            ),
          )
          .returning({ id: businessDeletionRequests.id });

        if (settled.length === 0) {
          return { outcome: 'settled' };
        }

        const secretsErased = await eraseAndSoftDelete(tx, request.businessId, now);

        return { outcome: 'deleted', businessId: request.businessId, secretsErased };
      });
    },

    async cancel(db, businessId, actorUserId) {
      // No ownership check. Cancelling is the safe direction, and a manager who
      // notices a deletion request they did not expect should be able to stop
      // it without first being promoted.
      const cancelled = await db
        .update(businessDeletionRequests)
        .set({ cancelledAt: new Date(), cancelledByUserId: actorUserId })
        .where(
          and(
            eq(businessDeletionRequests.businessId, businessId),
            isNull(businessDeletionRequests.confirmedAt),
            isNull(businessDeletionRequests.cancelledAt),
          ),
        )
        .returning({ id: businessDeletionRequests.id });

      return cancelled.length > 0;
    },

    async outstanding(db, businessId) {
      const rows = await db
        .select()
        .from(businessDeletionRequests)
        .where(
          and(
            eq(businessDeletionRequests.businessId, businessId),
            isNull(businessDeletionRequests.confirmedAt),
            isNull(businessDeletionRequests.cancelledAt),
          ),
        )
        .limit(1);

      return rows[0] ?? null;
    },
  };
}

type Executor = Pick<Database, 'execute'>;

/**
 * D-056, carried out.
 *
 * "Soft-delete referenced entities, erase purposeless secrets, retain
 * structural evidence." Each of the three is a separate statement below and
 * each is worth its own sentence.
 *
 * The business is marked deleted rather than dropped. `listBusinessesFor`
 * already filters on `deleted_at`, so it leaves every switcher and every screen
 * the moment this commits, and the ledger it explains stays readable to
 * somebody investigating afterwards.
 *
 * The secrets go, and they go completely. A deleted business's stored eBay
 * refresh token is a live credential to somebody's marketplace account with
 * nobody left to notice it being used; section 19 requires erasing credentials
 * that no longer have a purpose, and this is the moment they stop having one.
 * This is the irreversible half of the operation.
 *
 * The connections are disconnected and their schedules paused, because a soft
 * delete leaves rows the worker would otherwise keep polling — with credentials
 * that are now gone, producing a stream of authentication failures about a
 * business that no longer exists.
 *
 * Audit rows are untouched, and they survive because `audit_events` carries no
 * foreign key to `businesses` by design. That is the retained structural
 * evidence: the record of the deletion cannot live inside the thing deleted.
 */
async function eraseAndSoftDelete(db: Executor, businessId: string, now: Date): Promise<number> {
  const id = sql`${businessId}::uuid`;
  const at = sql`${now.toISOString()}::timestamptz`;

  await db.execute(sql`
    update businesses set status = 'deleted', deleted_at = ${at}, updated_at = ${at}
     where id = ${id} and deleted_at is null
  `);

  let erased = 0;

  for (const table of [
    sql`connection_secrets`,
    sql`ai_provider_secrets`,
    sql`shipping_account_secrets`,
    sql`alert_destination_secrets`,
  ]) {
    const removed = await db.execute(sql`delete from ${table} where business_id = ${id}`);
    erased += removed.rowCount ?? 0;
  }

  await db.execute(sql`
    update connections
       set status = 'disconnected', disconnected_at = coalesce(disconnected_at, ${at}),
           updated_at = ${at}
     where business_id = ${id}
  `);

  await db.execute(sql`
    update connection_sync_settings
       set paused = true,
           paused_reason = 'the business was deleted',
           updated_at = ${at}
     where business_id = ${id}
  `);

  return erased;
}
