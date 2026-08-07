import { connections, webhookDeliveries, type Database } from '@eim/db';
import { and, eq } from 'drizzle-orm';

import type { EbayEnvironment } from '../environment';
import { parseJsonObject, stringField } from './rest';
import type { SignatureVerifier, VerificationFailure } from './signature';

/**
 * Receiving a notification (section 14).
 *
 * Section 14's rule is persist before acknowledge, and it is a rule about
 * crashes rather than about storage. eBay stops redelivering once it has a 200,
 * so anything this application does *after* answering and before finishing is
 * work that is lost silently if the process dies in between. Writing the
 * delivery down first makes the acknowledgement honest: the event is durable,
 * and processing it is a separate step that can be retried from the row.
 *
 * The order of the checks below is deliberate, and each step earns the next:
 *
 *   Size first, because an unbounded body is a denial of service that does not
 *   need a valid signature.
 *
 *   Signature second, before the payload is used for anything at all. An
 *   unverified body is attacker-controlled text; using its seller identifier to
 *   choose which business's table to write to would let anyone on the internet
 *   fill any business's delivery log. Nothing unverified is stored, and the
 *   refusal is a refusal — section 14 does not permit an unverified delivery to
 *   be processed, and the database enforces it independently.
 *
 *   Attribution third. A notification names a seller, and a seller may be
 *   connected by more than one business in the same installation. It is
 *   recorded once per connection, because "handled" for one business says
 *   nothing about the other.
 *
 *   Deduplication last, on eBay's own notification identifier. eBay redelivers
 *   on any doubt about the answer, and a redelivery must not become a second
 *   event: for an order that would be a second stock movement.
 *
 * A verified notification about a seller nobody here has connected is
 * acknowledged and not stored. It is a fact about somebody else's account,
 * there is no connection to attach it to, and eBay redelivering it forever
 * helps nobody.
 */

/** Bigger than any eBay notification, small enough that a flood is bounded. */
const MAX_BODY_BYTES = 256 * 1024;

export type IntakeRefusal =
  | 'too_large'
  | 'unverified'
  | 'unreadable'
  /** Verified, well-formed, and about a seller no connection here names. */
  | 'unattributed';

export type IntakeResult =
  | {
      readonly ok: true;
      readonly topic: string;
      readonly notificationId: string;
      /** One per connection that names this seller. */
      readonly recorded: readonly { connectionId: string; businessId: string }[];
      /** True when every connection had already recorded this delivery. */
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly refusal: IntakeRefusal;
      /** Present when the signature is why. */
      readonly reason?: VerificationFailure;
    };

export interface IntakeOptions {
  readonly db: Database;
  readonly environment: EbayEnvironment;
  readonly verifier: SignatureVerifier;
}

export interface NotificationIntake {
  receive(input: {
    /** The bytes exactly as received. Not a parsed object. */
    body: string;
    signatureHeader: string | null | undefined;
    /** Non-authenticating headers, for diagnosis. */
    headers?: Readonly<Record<string, string>>;
    now?: Date;
  }): Promise<IntakeResult>;
}

export function createNotificationIntake(options: IntakeOptions): NotificationIntake {
  const { db } = options;

  return {
    async receive(input) {
      const now = input.now ?? new Date();

      if (Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES) {
        return { ok: false, refusal: 'too_large' };
      }

      const verification = await options.verifier.verify({
        body: input.body,
        signatureHeader: input.signatureHeader,
        now,
      });

      if (!verification.verified) {
        return { ok: false, refusal: 'unverified', reason: verification.reason };
      }

      const envelope = readEnvelope(input.body);

      if (envelope === null) {
        // Signed by eBay and shaped like nothing this application knows. Not
        // stored, because there is no topic to route it by and no identifier to
        // deduplicate it on.
        return { ok: false, refusal: 'unreadable' };
      }

      const owners = await db
        .select({ id: connections.id, businessId: connections.businessId })
        .from(connections)
        .where(
          and(
            eq(connections.provider, 'ebay'),
            eq(connections.environment, options.environment),
            eq(connections.externalAccountId, envelope.sellerId),
          ),
        );

      if (owners.length === 0) {
        return { ok: false, refusal: 'unattributed' };
      }

      const headers = safeHeaders(input.headers ?? {});
      const recorded: { connectionId: string; businessId: string }[] = [];
      let inserted = 0;

      for (const owner of owners) {
        const rows = await db
          .insert(webhookDeliveries)
          .values({
            businessId: owner.businessId,
            connectionId: owner.id,
            topic: envelope.topic,
            externalDeliveryId: envelope.notificationId,
            resourceType: envelope.resourceType,
            resourceId: envelope.resourceId,
            signatureVerified: true,
            receivedAt: now,
            status: 'received',
            rawBody: input.body,
            headers,
          })
          // The unique index on (connection, delivery identifier) is what makes
          // this idempotent. Doing it in the database rather than with a prior
          // read is what makes two workers receiving the same redelivery at the
          // same moment produce one row rather than two.
          .onConflictDoNothing()
          .returning({ id: webhookDeliveries.id });

        recorded.push({ connectionId: owner.id, businessId: owner.businessId });

        if (rows.length > 0) {
          inserted += 1;
        }
      }

      return {
        ok: true,
        topic: envelope.topic,
        notificationId: envelope.notificationId,
        recorded,
        duplicate: inserted === 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------

interface Envelope {
  readonly topic: string;
  readonly notificationId: string;
  readonly sellerId: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
}

/**
 * Reads eBay's notification envelope.
 *
 * The shape is `{ metadata: { topic, ... }, notification: { notificationId,
 * data: { ... } } }`. Everything required is required: a notification with no
 * identifier cannot be deduplicated, and one with no seller cannot be
 * attributed. Either would be stored somewhere arbitrary and acted on once.
 */
function readEnvelope(body: string): Envelope | null {
  const payload = parseJsonObject(body);

  if (payload === null) {
    return null;
  }

  const metadata = nested(payload, 'metadata');
  const notification = nested(payload, 'notification');
  const data = nested(notification, 'data');

  const topic = stringField(metadata, 'topic');
  const notificationId = stringField(notification, 'notificationId');
  const sellerId = firstOf(data, ['username', 'userId', 'sellerId', 'user_id']);

  if (topic === undefined || notificationId === undefined || sellerId === undefined) {
    return null;
  }

  const resource = resourceOf(data);

  return {
    topic,
    notificationId,
    sellerId,
    resourceType: resource?.type ?? null,
    resourceId: resource?.id ?? null,
  };
}

/**
 * What the notification is about, where eBay says so.
 *
 * Recorded for the benefit of whatever processes the row later; nothing here
 * depends on it, which is why an unrecognized payload is stored with nulls
 * rather than refused.
 */
function resourceOf(
  data: Record<string, unknown> | undefined,
): { type: string; id: string } | null {
  const candidates: readonly [string, string][] = [
    ['order', 'orderId'],
    ['order', 'legacyOrderId'],
    ['item', 'itemId'],
    ['item', 'listingId'],
    ['inventory_item', 'sku'],
    ['offer', 'offerId'],
  ];

  for (const [type, field] of candidates) {
    const value = stringField(data, field);

    if (value !== undefined) {
      return { type, id: value };
    }
  }

  return null;
}

function nested(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];

  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstOf(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = stringField(record, key);

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

/**
 * The headers worth keeping.
 *
 * The signature header is deliberately dropped. It is a credential for a body
 * that has already been verified, and storing it only extends the life of
 * something that has served its purpose. Everything else is kept lowercased and
 * bounded, for the operator staring at a delivery that made no sense.
 */
function safeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const keep: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();

    if (lower === 'x-ebay-signature' || lower === 'authorization' || lower === 'cookie') {
      continue;
    }

    keep[lower] = value.slice(0, 512);
  }

  return keep;
}
