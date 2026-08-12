import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AlertDestinationKind, AlertSeverity } from '@eim/db';

/**
 * What actually goes on the wire to a third party (sections 13, 22).
 *
 * Section 22: "minimal payloads without PII by default". The word doing the
 * work is *minimal*, and the way to keep a payload minimal is not to filter one
 * — it is to build it from a fixed list of fields, so that adding something is
 * an edit here rather than a consequence of somebody widening a type three
 * packages away.
 *
 * The list below has no buyer, no order, no address, no quantity, no price, and
 * no identifier belonging to a marketplace. An alert's `detail` is deliberately
 * not included: it is a free-shaped bag written at a dozen call sites, and a
 * bag is exactly the thing that quietly acquires an email address one day.
 *
 * Section 13's marketplace account-deletion obligations are the reason this is
 * strict rather than tidy. Buyer data that has left for a chat service is data
 * this application can no longer erase on request, and an erasure that cannot
 * reach every copy is not an erasure.
 */

/** Everything a destination is ever told about an alert. */
export interface AlertPayload {
  /** The alert's own identifier, so a receiver can deduplicate too. */
  readonly id: string;
  readonly event: 'alert.raised' | 'alert.reminder' | 'alert.resolved';
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly scope: 'business' | 'installation';
  /** One sentence, written at the call site. Never a credential or a buyer. */
  readonly summary: string;
  readonly recommendedAction: string | null;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Where a person can go and deal with it. A screen, never an action. */
  readonly url: string;
}

export interface AlertFacts {
  readonly id: string;
  readonly event: AlertPayload['event'];
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly scope: 'business' | 'installation';
  readonly summary: string;
  readonly recommendedAction: string | null;
  readonly occurrences: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly url: string;
}

/**
 * The payload, built field by field.
 *
 * Spelled out rather than spread from the row, so that a column added to
 * `operator_alerts` next year does not silently start being sent to a chat
 * service that nobody has reviewed since.
 */
export function alertPayload(facts: AlertFacts): AlertPayload {
  return {
    id: facts.id,
    event: facts.event,
    kind: facts.kind,
    severity: facts.severity,
    scope: facts.scope,
    summary: facts.summary,
    recommendedAction: facts.recommendedAction,
    occurrences: facts.occurrences,
    firstSeenAt: facts.firstSeenAt.toISOString(),
    lastSeenAt: facts.lastSeenAt.toISOString(),
    url: facts.url,
  };
}

/** A short human sentence, for services that render text rather than JSON. */
export function alertSentence(payload: AlertPayload): string {
  const seen = payload.occurrences === 1 ? '' : ` (seen ${String(payload.occurrences)} times)`;
  const action = payload.recommendedAction === null ? '' : `\n${payload.recommendedAction}`;

  return `[${payload.severity.toUpperCase()}] ${payload.summary}${seen}${action}\n${payload.url}`;
}

export interface WireRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The request body and headers for one destination kind.
 *
 * Slack and Discord get their own envelope because they insist on one; both
 * authenticate by the URL being secret, which is why neither is signed. Adding
 * a signature to a Slack webhook would be ceremony: anybody who has the URL can
 * already post, and anybody who does not cannot.
 *
 * The generic webhook is the one section 22 signs, and it is the only one that
 * receives the structured payload.
 */
export function wireRequest(
  kind: AlertDestinationKind,
  payload: AlertPayload,
  options: { readonly signingKey?: string; readonly deliveryId: string; readonly sentAt: Date },
): WireRequest {
  if (kind === 'slack') {
    return {
      body: JSON.stringify({ text: alertSentence(payload) }),
      headers: { 'content-type': 'application/json' },
    };
  }

  if (kind === 'discord') {
    return {
      body: JSON.stringify({ content: alertSentence(payload) }),
      headers: { 'content-type': 'application/json' },
    };
  }

  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(options.sentAt.getTime() / 1000));

  return {
    body,
    headers: {
      'content-type': 'application/json',
      // Section 22's idempotency identifier, so a receiver that is delivered the
      // same notification twice can tell.
      'x-eim-delivery': options.deliveryId,
      'x-eim-event': payload.event,
      'x-eim-timestamp': timestamp,
      ...(options.signingKey === undefined
        ? {}
        : { 'x-eim-signature': signPayload(options.signingKey, timestamp, body) }),
    },
  };
}

/**
 * The signature a receiver checks.
 *
 * The timestamp is inside the signed string rather than only in a header, so a
 * captured request cannot be replayed a week later with its own valid
 * signature. A receiver that ignores the timestamp is no worse off than one
 * that never had it; a receiver that checks it gets replay protection for free.
 *
 * `sha256=` prefixed in the GitHub style, because that is the convention every
 * webhook receiver library already knows how to parse.
 */
export function signPayload(signingKey: string, timestamp: string, body: string): string {
  const digest = createHmac('sha256', signingKey).update(`${timestamp}.${body}`).digest('hex');

  return `sha256=${digest}`;
}

/**
 * Whether a signature is the one this key would have produced.
 *
 * Exported so the documentation can point receivers at a reference
 * implementation, and compared in constant time so that the comparison itself
 * does not leak the correct value one byte at a time.
 */
export function verifySignature(
  signingKey: string,
  timestamp: string,
  body: string,
  candidate: string,
): boolean {
  const expected = Buffer.from(signPayload(signingKey, timestamp, body));
  const offered = Buffer.from(candidate);

  // Lengths differ only when the candidate is malformed, and comparing buffers
  // of different lengths throws rather than returning false.
  return expected.length === offered.length && timingSafeEqual(expected, offered);
}
