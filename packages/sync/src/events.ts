import { createHash } from 'node:crypto';

import type { QueueExecutor } from '@eim/jobs';
import { sql } from 'drizzle-orm';

/**
 * Deduplication for every inbound signal (sections 12, 15).
 *
 * One rule, applied at one place: an event this application has already
 * finished processing returns what it decided last time and mutates nothing.
 * Section 15 routes webhooks, polling, verification, and manual triggers
 * through the same pipeline precisely so that this check has to exist once —
 * and so that the same event arriving twice by two different routes still
 * deduplicates against itself, which is why the source is recorded but never
 * part of the key.
 *
 * Identity comes from the provider wherever the provider supplies it. The
 * payload fingerprint below is a fallback, not an equal alternative: two
 * genuinely distinct events can normalize to the same bytes — the same product
 * set to the same quantity twice — and treating them as one would silently lose
 * the second. Section 12 permits it only where no event id exists.
 */

export interface EventIdentity {
  readonly connectionId: string;
  readonly businessId?: string | null;
  readonly provider: string;
  readonly source: 'webhook' | 'poll' | 'verification' | 'manual' | 'reconciliation';
  readonly eventType: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  /** The provider's own event identifier, where it has one. */
  readonly externalEventId?: string;
  /** The provider's revision or sequence for the resource. */
  readonly revision?: string;
  /**
   * The normalized payload, hashed here. Only consulted when there is no
   * `externalEventId`; supplying both is harmless and the id still wins.
   */
  readonly payload?: unknown;
}

export type EventClaim<T> =
  | { readonly outcome: 'claimed'; readonly eventId: string }
  /** Section 12: return the prior outcome, mutate nothing. */
  | { readonly outcome: 'already_processed'; readonly eventId: string; readonly prior: T };

/**
 * Records an event as processed, or reports that it already was.
 *
 * Deliberately a single insert with `on conflict do nothing`. A select followed
 * by an insert would let two workers both find nothing and both proceed, which
 * for an order means reserving the same units twice — the exact failure
 * deduplication exists to prevent, appearing only under the concurrency that
 * makes it matter.
 *
 * The outcome is written when the work finishes, by `completeEvent`. A row
 * claimed but not completed marks an attempt that died mid-flight; the caller's
 * transaction takes it back on rollback, which is what keeps "claimed" and
 * "actually happened" the same thing.
 */
export async function claimEvent<T>(
  db: QueueExecutor,
  identity: EventIdentity,
): Promise<EventClaim<T>> {
  const fingerprint =
    identity.externalEventId === undefined ? fingerprintOf(identity.payload) : null;

  const inserted = await db.execute<{ id: string }>(sql`
    insert into processed_events (
      business_id, connection_id, provider, source, event_type,
      resource_type, resource_id, external_event_id, revision, payload_fingerprint
    )
    values (
      ${identity.businessId ?? null}, ${identity.connectionId}::uuid, ${identity.provider},
      ${identity.source}, ${identity.eventType},
      ${identity.resourceType ?? null}, ${identity.resourceId ?? null},
      ${identity.externalEventId ?? null}, ${identity.revision ?? null}, ${fingerprint}
    )
    on conflict do nothing
    returning id
  `);

  const claimed = inserted.rows[0];
  if (claimed !== undefined) {
    return { outcome: 'claimed', eventId: claimed.id };
  }

  const existing = await db.execute<{ id: string; outcome: T }>(
    identity.externalEventId === undefined
      ? sql`
          select id, outcome from processed_events
           where connection_id = ${identity.connectionId}::uuid
             and event_type = ${identity.eventType}
             and resource_id is not distinct from ${identity.resourceId ?? null}
             and payload_fingerprint = ${fingerprint}
             and external_event_id is null
           limit 1
        `
      : sql`
          select id, outcome from processed_events
           where connection_id = ${identity.connectionId}::uuid
             and event_type = ${identity.eventType}
             and external_event_id = ${identity.externalEventId}
           limit 1
        `,
  );

  const prior = existing.rows[0];
  if (prior === undefined) {
    // The conflicting row disappeared between the two statements, which only
    // happens when its transaction rolled back. Nothing has been processed, so
    // the honest answer is to try again rather than report a duplicate.
    return claimEvent<T>(db, identity);
  }

  return { outcome: 'already_processed', eventId: prior.id, prior: prior.outcome };
}

/** Stores what the event produced, so a replay can return it unchanged. */
export async function completeEvent(
  db: QueueExecutor,
  eventId: string,
  outcome: unknown,
): Promise<void> {
  await db.execute(sql`
    update processed_events
       set outcome = ${JSON.stringify(outcome ?? {})}::jsonb, processed_at = now()
     where id = ${eventId}::uuid
  `);
}

/**
 * Removes event records older than the retention window.
 *
 * Section 15 keeps normalized event metadata for 180 days by default, and
 * "structural idempotency keys ... for as long as correctness and deduplication
 * require them". In practice a provider will not redeliver an event months
 * later, so the two windows can be the same one; the caller decides how long.
 */
export async function pruneProcessedEvents(
  db: QueueExecutor,
  olderThanMs: number,
): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    delete from processed_events
     where processed_at < now() - make_interval(secs => ${olderThanMs / 1000})
    returning id
  `);

  return rows.rows.length;
}

/**
 * A stable hash of a normalized payload.
 *
 * Keys are sorted before hashing, because two JSON objects that differ only in
 * key order describe the same event and a hash that disagreed would defeat the
 * deduplication it exists to provide.
 */
export function fingerprintOf(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // Everything JSON can carry, and nothing else. `JSON.stringify` answers
    // `undefined` rather than a string for the rest — undefined itself, a
    // function, a symbol — and those are absence, not a value worth hashing.
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? JSON.stringify(value)
      : 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

  return `{${entries.join(',')}}`;
}
