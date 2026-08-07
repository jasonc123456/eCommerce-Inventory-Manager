import {
  marketplaceDeletionOutcomes,
  marketplaceDeletionRequests,
  providerOrders,
  webhookDeliveries,
  type Database,
} from '@eim/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { challengeResponse } from './challenge';
import { parseJsonObject, stringField } from './rest';
import type { SignatureVerifier, VerificationFailure } from './signature';

/**
 * Marketplace account deletion (section 13, D-137).
 *
 * eBay requires this endpoint because this application stores order and buyer
 * data. When a buyer closes their eBay account, eBay tells every application
 * holding their data to erase it, and the obligation is not satisfied by
 * answering the request — it is satisfied by the data being gone.
 *
 * Three properties shape everything below:
 *
 *   Erasure is irreversible, so authentication comes first and is absolute. An
 *   unauthenticated instruction to erase is a denial-of-service primitive: it
 *   would let anyone on the internet destroy a seller's order history by
 *   naming their buyers. Nothing unverified is ever acted on, and the database
 *   refuses to let a request move past `received` without a verified signature
 *   even if this code tried.
 *
 *   The endpoint is registered once per application; the data is held per
 *   business. D-137: one installation may hold that buyer's records under
 *   several businesses, so a verified request fans out, and it is complete only
 *   when every affected business has been processed. Each business gets its own
 *   outcome row and its own transaction, because a single status would report
 *   success the moment the first business finished while another still held the
 *   data — an answer that is both wrong and, to eBay, a false compliance claim.
 *
 *   A non-PII receipt remains. What survives is that a request arrived, which
 *   businesses were processed, and how many records changed. Not who. A
 *   compliance record naming the person it erased is not one.
 */

/** eBay's deletion notifications are small; this is generous. */
const MAX_BODY_BYTES = 64 * 1024;

export type DeletionRefusal = 'too_large' | 'unreadable' | 'unverified';

export interface DeletionSummary {
  readonly requestId: string;
  readonly status: 'completed' | 'partially_failed';
  /** How many businesses held data for this buyer. */
  readonly businesses: number;
  readonly recordsAffected: number;
  /** True when this notification had already been processed. */
  readonly duplicate: boolean;
}

export type DeletionResult =
  | { readonly ok: true; readonly summary: DeletionSummary }
  | {
      readonly ok: false;
      readonly refusal: DeletionRefusal;
      readonly reason?: VerificationFailure;
      /** Set when an unverified request was recorded as evidence. */
      readonly recordedAs?: string;
    };

export interface DeletionOptions {
  readonly db: Database;
  readonly verifier: SignatureVerifier;
  /**
   * The endpoint exactly as registered in eBay's portal. Part of the challenge
   * hash, so a mismatch here fails validation with no other symptom.
   */
  readonly endpoint: string;
  readonly verificationToken: string;
}

export interface MarketplaceDeletion {
  /** Answers eBay's endpoint validation challenge. */
  challenge(challengeCode: string): string | null;
  /** Handles a deletion notification, end to end. */
  receive(input: {
    body: string;
    signatureHeader: string | null | undefined;
    now?: Date;
  }): Promise<DeletionResult>;
  /** Re-runs the businesses a previous pass could not finish. */
  retry(requestId: string, now?: Date): Promise<DeletionResult>;
}

export function createMarketplaceDeletion(options: DeletionOptions): MarketplaceDeletion {
  const { db } = options;

  return {
    challenge(challengeCode) {
      return challengeResponse({
        challengeCode,
        verificationToken: options.verificationToken,
        endpoint: options.endpoint,
      });
    },

    async receive(input) {
      const now = input.now ?? new Date();

      if (Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES) {
        return { ok: false, refusal: 'too_large' };
      }

      const request = readDeletionNotification(input.body);

      if (request === null) {
        return { ok: false, refusal: 'unreadable' };
      }

      const verification = await options.verifier.verify({
        body: input.body,
        signatureHeader: input.signatureHeader,
        now,
      });

      if (!verification.verified) {
        // Recorded, never acted on. The row is evidence that somebody tried,
        // which is worth having on an endpoint whose address is public and
        // whose effect is destruction; the constraint on the table is what
        // guarantees it stays inert.
        const [row] = await db
          .insert(marketplaceDeletionRequests)
          .values({
            buyerExternalId: request.buyerId,
            notificationId: request.notificationId,
            verified: false,
            status: 'rejected',
            receivedAt: now,
            completedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: marketplaceDeletionRequests.id });

        return {
          ok: false,
          refusal: 'unverified',
          reason: verification.reason,
          ...(row === undefined ? {} : { recordedAs: row.id }),
        };
      }

      const [created] = await db
        .insert(marketplaceDeletionRequests)
        .values({
          buyerExternalId: request.buyerId,
          notificationId: request.notificationId,
          verified: true,
          status: 'processing',
          receivedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: marketplaceDeletionRequests.id });

      if (created === undefined) {
        // eBay redelivers when it is unsure of the answer. The erasure already
        // happened, or is happening; running it again would find nothing and
        // report zero, which reads like a failure.
        const [existing] = await db
          .select()
          .from(marketplaceDeletionRequests)
          .where(eq(marketplaceDeletionRequests.notificationId, request.notificationId))
          .limit(1);

        if (existing === undefined) {
          // Vanishingly unlikely — the row was deleted between the insert and
          // the read — and not worth inventing a state for.
          return { ok: false, refusal: 'unreadable' };
        }

        if (!existing.verified) {
          // A forgery arrived first under this notification identifier and was
          // recorded as rejected. Left alone, that unique index would make
          // pre-registering an identifier a way to block the genuine erasure
          // permanently, which is a compliance failure an attacker can cause on
          // purpose. The genuine one takes the row over and proceeds.
          await db
            .update(marketplaceDeletionRequests)
            .set({ verified: true, status: 'processing', completedAt: null, receivedAt: now })
            .where(eq(marketplaceDeletionRequests.id, existing.id));

          return {
            ok: true,
            summary: await erase(db, existing.id, request.identifiers, now, false),
          };
        }

        const totals = await totalsFor(db, existing.id);

        return {
          ok: true,
          summary: {
            requestId: existing.id,
            status: existing.status === 'partially_failed' ? 'partially_failed' : 'completed',
            businesses: totals.businesses,
            recordsAffected: totals.recordsAffected,
            duplicate: true,
          },
        };
      }

      return {
        ok: true,
        summary: await erase(db, created.id, request.identifiers, now, false),
      };
    },

    async retry(requestId, now = new Date()) {
      const [request] = await db
        .select()
        .from(marketplaceDeletionRequests)
        .where(eq(marketplaceDeletionRequests.id, requestId))
        .limit(1);

      if (!request?.verified) {
        // Nothing unverified is ever acted on, including on a second look.
        return { ok: false, refusal: 'unverified' };
      }

      // Only the identifier the request was filed under, because that is what
      // survived. It is the same one the orders were stored under: the order
      // mapper keeps eBay's buyer username and nothing else, and the request
      // records the first identifier eBay sent, which is that username.
      return {
        ok: true,
        summary: await erase(db, request.id, [request.buyerExternalId], now, true),
      };
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Erases the buyer from every business that holds them.
 *
 * Each business is its own transaction. One that fails is recorded as failed
 * and the rest continue: the alternative — one transaction over the whole
 * installation — means a lock contention in one business leaves every other
 * business's obligation unmet, and reports nothing at all.
 */
async function erase(
  db: Database,
  requestId: string,
  identifiers: readonly string[],
  now: Date,
  retrying: boolean,
): Promise<DeletionSummary> {
  const holders = await db
    .selectDistinct({ businessId: providerOrders.businessId })
    .from(providerOrders)
    .where(inArray(providerOrders.buyerExternalId, [...identifiers]));

  // On a retry the businesses already recorded matter too: one that failed
  // before may now hold nothing precisely because a concurrent pass finished
  // it, and its outcome still has to stop saying "failed".
  const outstanding = retrying
    ? await db
        .select({ businessId: marketplaceDeletionOutcomes.businessId })
        .from(marketplaceDeletionOutcomes)
        .where(
          and(
            eq(marketplaceDeletionOutcomes.requestId, requestId),
            eq(marketplaceDeletionOutcomes.status, 'failed'),
          ),
        )
    : [];

  const businessIds = [...new Set([...holders, ...outstanding].map((row) => row.businessId))];

  let failures = 0;

  for (const businessId of businessIds) {
    try {
      const affected = await eraseForBusiness(db, businessId, identifiers);

      await db
        .insert(marketplaceDeletionOutcomes)
        .values({
          requestId,
          businessId,
          status: affected.orders > 0 ? 'completed' : 'nothing_to_erase',
          summary: receiptFor(affected),
          recordsAffected: affected.orders,
          attemptedAt: now,
          completedAt: now,
        })
        .onConflictDoUpdate({
          target: [marketplaceDeletionOutcomes.requestId, marketplaceDeletionOutcomes.businessId],
          set: {
            status: sql`excluded.status`,
            summary: sql`excluded.summary`,
            // Added to rather than replaced: a retry that erases the remainder
            // should not make the receipt claim the first pass did nothing.
            recordsAffected: sql`${marketplaceDeletionOutcomes.recordsAffected} + excluded.records_affected`,
            attemptedAt: sql`excluded.attempted_at`,
            completedAt: sql`excluded.completed_at`,
          },
        });
    } catch {
      failures += 1;

      // The reason is not stored. It would be a database error string about a
      // row that names a person, on a record whose entire purpose is to survive
      // that person's erasure.
      await db
        .insert(marketplaceDeletionOutcomes)
        .values({
          requestId,
          businessId,
          status: 'failed',
          summary: 'the erasure did not complete and will be retried',
          attemptedAt: now,
        })
        .onConflictDoUpdate({
          target: [marketplaceDeletionOutcomes.requestId, marketplaceDeletionOutcomes.businessId],
          set: {
            status: sql`excluded.status`,
            summary: sql`excluded.summary`,
            attemptedAt: sql`excluded.attempted_at`,
            completedAt: sql`null`,
          },
        });
    }
  }

  const status = failures > 0 ? 'partially_failed' : 'completed';

  await db
    .update(marketplaceDeletionRequests)
    .set({ status, completedAt: now })
    .where(eq(marketplaceDeletionRequests.id, requestId));

  const totals = await totalsFor(db, requestId);

  return {
    requestId,
    status,
    businesses: totals.businesses,
    recordsAffected: totals.recordsAffected,
    duplicate: false,
  };
}

interface Affected {
  readonly orders: number;
  readonly deliveries: number;
}

async function eraseForBusiness(
  db: Database,
  businessId: string,
  identifiers: readonly string[],
): Promise<Affected> {
  return db.transaction(async (tx) => {
    const orders = await tx
      .update(providerOrders)
      .set({
        buyerExternalId: null,
        // The buyer block is removed from the retained payload rather than the
        // whole payload being discarded: the order itself is a business record
        // under ordinary retention, and only the person has to go.
        raw: sql`${providerOrders.raw} - 'buyer'`,
      })
      .where(
        and(
          eq(providerOrders.businessId, businessId),
          inArray(providerOrders.buyerExternalId, [...identifiers]),
        ),
      )
      .returning({ externalId: providerOrders.externalId });

    if (orders.length === 0) {
      return { orders: 0, deliveries: 0 };
    }

    // The raw notification bodies for those orders carry the same buyer data.
    // They would age out under section 35's raw-event window on their own;
    // clearing them now is what makes the erasure true today rather than in
    // thirty days.
    const cleared = await tx
      .update(webhookDeliveries)
      .set({ rawBody: null })
      .where(
        and(
          eq(webhookDeliveries.businessId, businessId),
          inArray(
            webhookDeliveries.resourceId,
            orders.map((order) => order.externalId),
          ),
        ),
      )
      .returning({ id: webhookDeliveries.id });

    return { orders: orders.length, deliveries: cleared.length };
  });
}

/** What is safe to keep: counts, never the person they refer to. */
function receiptFor(affected: Affected): string {
  if (affected.orders === 0) {
    return 'no records remained for this buyer';
  }

  return `${String(affected.orders)} order${affected.orders === 1 ? '' : 's'} anonymized, ${String(affected.deliveries)} raw payload${affected.deliveries === 1 ? '' : 's'} cleared`;
}

async function totalsFor(
  db: Database,
  requestId: string,
): Promise<{ businesses: number; recordsAffected: number }> {
  const rows = await db
    .select({ recordsAffected: marketplaceDeletionOutcomes.recordsAffected })
    .from(marketplaceDeletionOutcomes)
    .where(eq(marketplaceDeletionOutcomes.requestId, requestId));

  return {
    businesses: rows.length,
    recordsAffected: rows.reduce((total, row) => total + row.recordsAffected, 0),
  };
}

interface DeletionNotification {
  readonly notificationId: string;
  /** The identifier the receipt is filed under. */
  readonly buyerId: string;
  /** Every identifier eBay gave for this buyer, for finding their records. */
  readonly identifiers: readonly string[];
}

/**
 * Reads eBay's deletion notification.
 *
 * eBay sends more than one identifier for the same person — a username, an
 * internal user identifier, an EIAS token — and which one an order was stored
 * under depends on when it was imported. All of them are searched; missing one
 * means data that was supposed to be erased is still there.
 */
function readDeletionNotification(body: string): DeletionNotification | null {
  const payload = parseJsonObject(body);

  if (payload === null) {
    return null;
  }

  const metadata = payload['metadata'];
  const topic =
    typeof metadata === 'object' && metadata !== null
      ? stringField(metadata as Record<string, unknown>, 'topic')
      : undefined;

  if (!topic?.toUpperCase().includes('ACCOUNT_DELETION')) {
    return null;
  }

  const notification = payload['notification'];

  if (typeof notification !== 'object' || notification === null) {
    return null;
  }

  const record = notification as Record<string, unknown>;
  const notificationId = stringField(record, 'notificationId');
  const data = record['data'];

  if (notificationId === undefined || typeof data !== 'object' || data === null) {
    return null;
  }

  const buyer = data as Record<string, unknown>;
  const identifiers = ['username', 'userId', 'eiasToken']
    .map((key) => stringField(buyer, key))
    .filter((value): value is string => value !== undefined);

  const [buyerId] = identifiers;

  if (buyerId === undefined) {
    return null;
  }

  return { notificationId, buyerId, identifiers };
}
