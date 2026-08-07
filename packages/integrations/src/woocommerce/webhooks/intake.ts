import { createHash } from 'node:crypto';

import { connections, webhookDeliveries, type Database } from '@eim/db';
import type { UrlPolicy } from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import type { SecretStore } from '../../secrets';
import { describeStore, sameOrigin } from '../store';
import { MANAGED_TOPICS, verifiableSecrets, type WooWebhooks } from './registration';
import { verifyWebhookSignature, type WebhookVerificationFailure } from './signature';

/**
 * Receiving a WooCommerce delivery (section 14).
 *
 * The order of the checks is the substance of this file, and each step earns the
 * next:
 *
 *   Size first. An unbounded body is a denial of service that needs no valid
 *   signature, and it is checked before anything reads the body as anything but
 *   bytes.
 *
 *   Content type second, because it costs nothing and section 14 asks for it.
 *
 *   Connection third — from the URL, never from a header. The delivery arrives
 *   at a per-connection path this application chose, so which store's secrets
 *   this is checked against is not something the sender can influence. Using
 *   `X-WC-Webhook-Source` instead would let anyone on the internet nominate
 *   which business's webhook secrets they are compared with.
 *
 *   Signature fourth, against every live secret for that connection. The
 *   registration that matches is thereby *identified* rather than claimed:
 *   `X-WC-Webhook-ID` is not consulted, because during a rotation two secrets
 *   are live and a sender who picks the registration picks the key.
 *
 *   Origin fifth, and only as corroboration. Section 14 is explicit that headers
 *   other than the signature are metadata rather than authentication, so a
 *   `X-WC-Webhook-Source` naming another store is recorded and the delivery is
 *   refused — not because the header proves anything, but because a verified
 *   body arriving with the wrong source is a misconfiguration that will
 *   otherwise be diagnosed as data corruption weeks later.
 *
 *   Persisted last, and before the answer. WooCommerce stops redelivering on a
 *   2xx and disables the registration after repeated non-2xx, so the answer has
 *   to mean what it says: the row is durable before the response is written, and
 *   processing it is a separate step that can be retried from the row.
 */

/** Larger than any core WooCommerce payload; small enough that a flood is bounded. */
const MAX_BODY_BYTES = 1024 * 1024;

export type WooIntakeRefusal =
  | 'too_large'
  | 'unknown_connection'
  | 'wrong_content_type'
  | 'unverified'
  | 'wrong_store'
  | 'unmanaged_topic'
  | 'unreadable';

export type WooIntakeResult =
  | {
      readonly ok: true;
      readonly topic: string;
      readonly deliveryId: string | null;
      readonly resourceId: string | null;
      /** Which registration's secret verified it. */
      readonly webhookId: string;
      /** True when this event had already been recorded, including via a rotation's overlap. */
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly refusal: WooIntakeRefusal;
      readonly reason?: WebhookVerificationFailure;
    };

export interface WooIntakeOptions {
  readonly db: Database;
  readonly secrets: SecretStore;
  readonly policy: UrlPolicy;
  /** Told when a delivery verifies, so a rotation can complete. */
  readonly webhooks: Pick<WooWebhooks, 'observe'>;
}

export interface WooIntake {
  receive(input: {
    /** From the URL this delivery arrived at, not from the body. */
    connectionId: string;
    /** The bytes exactly as received. Not a parsed object. */
    body: string;
    headers: Readonly<Record<string, string>>;
    now?: Date;
  }): Promise<WooIntakeResult>;
}

export function createWooIntake(options: WooIntakeOptions): WooIntake {
  const { db, secrets } = options;

  return {
    async receive(input) {
      const now = input.now ?? new Date();

      if (Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES) {
        return { ok: false, refusal: 'too_large' };
      }

      const contentType = header(input.headers, 'content-type');

      if (contentType !== null && !contentType.toLowerCase().includes('json')) {
        return { ok: false, refusal: 'wrong_content_type' };
      }

      const [connection] = await db
        .select({ businessId: connections.businessId, store: connections.externalAccountId })
        .from(connections)
        .where(and(eq(connections.id, input.connectionId), eq(connections.provider, 'woocommerce')))
        .limit(1);

      if (connection === undefined) {
        return { ok: false, refusal: 'unknown_connection' };
      }

      const ref = { businessId: connection.businessId, connectionId: input.connectionId };
      const candidates = await verifiableSecrets(db, secrets, ref);

      const verification = verifyWebhookSignature({
        body: input.body,
        signatureHeader: header(input.headers, 'x-wc-webhook-signature'),
        secrets: candidates,
      });

      if (!verification.verified) {
        return { ok: false, refusal: 'unverified', reason: verification.reason };
      }

      const described = describeStore(connection.store, options.policy);
      const source = header(input.headers, 'x-wc-webhook-source');

      if (source !== null && described.ok && !sameOrigin(described.store.origin, source)) {
        return { ok: false, refusal: 'wrong_store' };
      }

      const envelope = readEnvelope(input.body, input.headers);

      if (envelope === null) {
        return { ok: false, refusal: 'unreadable' };
      }

      if (!(MANAGED_TOPICS as readonly string[]).includes(envelope.topic)) {
        // Verified, well-formed, and about something nothing here acts on — a
        // webhook somebody added by hand for a topic outside the supported set.
        // Acknowledged rather than refused, because asking the store to redeliver
        // it forever helps nobody and eventually disables the registration.
        return { ok: false, refusal: 'unmanaged_topic' };
      }

      const inserted = await db
        .insert(webhookDeliveries)
        .values({
          businessId: connection.businessId,
          connectionId: input.connectionId,
          topic: envelope.topic,
          externalDeliveryId: envelope.deliveryId,
          resourceType: envelope.resourceType,
          resourceId: envelope.resourceId,
          signatureVerified: true,
          receivedAt: now,
          status: 'received',
          rawBody: input.body,
          headers: safeHeaders(input.headers),
          dedupeKey: dedupeKey(envelope.topic, envelope.resourceId, input.body),
        })
        // Two unique indexes decide this, and both matter. The delivery
        // identifier catches WooCommerce redelivering after a timeout; the
        // content fingerprint catches a rotation's two live registrations
        // delivering one event twice under two different identifiers.
        .onConflictDoNothing()
        .returning({ id: webhookDeliveries.id });

      // Only after the row is durable. A rotation that promoted its replacement
      // before the delivery proving it was written down could lose that delivery
      // to a crash and have no record that the replacement ever worked.
      await options.webhooks.observe({ ...ref, webhookId: verification.webhookId, now });

      return {
        ok: true,
        topic: envelope.topic,
        deliveryId: envelope.deliveryId,
        resourceId: envelope.resourceId,
        webhookId: verification.webhookId,
        duplicate: inserted.length === 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------

interface Envelope {
  readonly topic: string;
  readonly deliveryId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
}

/**
 * What the delivery is about.
 *
 * The topic comes from the header rather than the body, because WooCommerce puts
 * it only in the header — the body is the resource itself, with no envelope
 * around it. That is safe here in a way it would not be one step earlier: the
 * signature has already been checked, so a sender who lies about the topic is
 * lying about a body they also had to sign, which they cannot do without the
 * secret. The topic decides routing, never trust.
 */
function readEnvelope(body: string, headers: Readonly<Record<string, string>>): Envelope | null {
  const topic = header(headers, 'x-wc-webhook-topic');

  if (topic === null) {
    return null;
  }

  const resource = header(headers, 'x-wc-webhook-resource');
  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }

  const record =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;

  const id = record?.['id'];

  return {
    topic,
    deliveryId: header(headers, 'x-wc-webhook-delivery-id'),
    resourceType: resource ?? topic.split('.')[0] ?? null,
    resourceId:
      typeof id === 'number' && Number.isInteger(id)
        ? String(id)
        : typeof id === 'string' && id.length > 0
          ? id
          : null,
  };
}

/**
 * A fingerprint of the event rather than of the registration that carried it.
 *
 * Section 14 deduplicates on delivery identity *plus resource identity*, and the
 * resource half is what makes a rotation's overlap harmless: the same event
 * delivered by two registrations carries two delivery identifiers and produces
 * one fingerprint.
 *
 * The body is part of it. Two genuinely different updates to one product
 * otherwise collapse into one, and the second — the one that actually changed
 * something — would be discarded.
 */
export function dedupeKey(topic: string, resourceId: string | null, body: string): string {
  return createHash('sha256')
    .update(topic, 'utf8')
    .update(' ', 'utf8')
    .update(resourceId ?? '', 'utf8')
    .update(' ', 'utf8')
    .update(body, 'utf8')
    .digest('hex');
}

export function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  const lower = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value.length > 0) {
      return value;
    }
  }

  return null;
}

/**
 * The headers worth keeping.
 *
 * The signature is dropped: it is a credential for a body that has already been
 * verified, and storing it only extends the life of something that has served
 * its purpose.
 */
function safeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const keep: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();

    if (lower === 'x-wc-webhook-signature' || lower === 'authorization' || lower === 'cookie') {
      continue;
    }

    keep[lower] = value.slice(0, 512);
  }

  return keep;
}
