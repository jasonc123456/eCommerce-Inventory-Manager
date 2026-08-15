import { connectionCursors, type Database } from '@eim/db';
import {
  JobPriority,
  enqueue,
  type ClaimedJob,
  type JobResult,
  type QueueExecutor,
} from '@eim/jobs';
import type { ChangeOrigin } from '@eim/pilot';
import { describeFailure, type ProviderFailure } from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import type { DispatchDependencies } from './dispatch';
import { toJobFailure } from './failures';
import { applyCancellation, applyFulfillment, applyRefund } from './lifecycle';
import { ingestOrder, type NormalizedOrder } from './orders';
import type { EventSource } from './events';

/**
 * One path in, whatever woke us up (section 15).
 *
 * Section 15 requires that webhooks, polling, targeted verification, and manual
 * triggers "feed the same durable, idempotent processing pipeline rather than
 * implementing separate mutation paths". This module is that pipeline, and the
 * shape it takes follows from one more sentence in the same section: "treat
 * webhook content as a signal that state may have changed, not as the final
 * inventory truth."
 *
 * So nothing here reads a payload for quantities. A trigger names a resource;
 * the worker fetches that resource from the provider as it currently stands;
 * the current state decides what happens. That costs one API call per event and
 * buys immunity to every incomplete, delayed, duplicated, and out-of-order
 * payload a provider can produce — which section 12 spends a page describing
 * and which no amount of payload parsing can survive.
 *
 * The overlap window in the poller is the same idea from the other direction. A
 * poll that resumed exactly where it left off would lose anything the provider
 * made visible a second late; one that overlaps re-sees events it has already
 * handled, and the deduplication boundary makes that free.
 */

export const ORDER_SYNC_JOB = 'order.sync';
export const ORDER_POLL_JOB = 'order.poll';

/** The stream name under which the order watermark is stored. */
export const ORDER_STREAM = 'orders';

/**
 * How far back a poll reaches before its last watermark.
 *
 * Fifteen minutes rather than a few seconds. The cost of overlap is a handful
 * of events that deduplicate to nothing; the cost of too little is a sale that
 * was never accounted for, and providers are not consistent about when an order
 * becomes visible relative to the timestamp they stamp on it.
 */
export const POLL_OVERLAP_MS = 15 * 60 * 1000;

/**
 * Queues a fetch-and-decide for one order.
 *
 * Called by webhook intake, by the poller, and by a person pressing a button.
 * All three produce the same job, which is what makes "the same pipeline" true
 * rather than aspirational.
 */
export async function requestOrderSync(
  db: QueueExecutor,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly externalOrderId: string;
    readonly source: EventSource;
    /** The provider's event id, where the trigger had one. */
    readonly externalEventId?: string;
    /**
     * When this trigger was noticed. Defaults to now, which is correct for
     * every current caller: a webhook handler calls this on receipt, and the
     * poller calls it on discovery.
     *
     * Carried on the payload rather than read from the job's timestamps because
     * a retried job's `run_at` is pushed forward by backoff — measuring from it
     * would credit us for the delay we just caused.
     */
    readonly noticedAt?: Date;
  },
): Promise<void> {
  await enqueue(db, {
    kind: ORDER_SYNC_JOB,
    businessId: input.businessId,
    connectionId: input.connectionId,
    priority: JobPriority.orderIngestion,
    // Two triggers about one order are one piece of work. Section 15 asks for
    // repeated wake-ups to be coalesced, and an order is exactly the entity it
    // means: a webhook, its overlapping poll, and an impatient operator all
    // want the same fetch.
    dedupeKey: `order:${input.connectionId}:${input.externalOrderId}`,
    // Serialized per order so two triggers cannot both be committing it.
    serializationKey: `order:${input.connectionId}:${input.externalOrderId}`,
    payload: {
      externalOrderId: input.externalOrderId,
      source: input.source,
      // Section 1's clock starts here. Note the interaction with the dedupe key
      // above: two triggers about one order collapse, the first insert wins, and
      // the surviving job keeps the *earlier* notice. That is the conservative
      // choice — a webhook and its overlapping poll are measured from whichever
      // told us first, which is the earliest moment we could have acted.
      noticedAt: (input.noticedAt ?? new Date()).toISOString(),
      ...(input.externalEventId === undefined ? {} : { externalEventId: input.externalEventId }),
    },
  });
}

/**
 * Fetches one order and applies whatever it currently says.
 *
 * The routing below is the only place order state becomes an inventory
 * decision, and it is deliberately a single switch. A provider that reports an
 * order as cancelled has said one thing, and the system does one thing about
 * it; spreading that across a handler per webhook topic is how two topics end
 * up disagreeing about what "cancelled" means.
 */
export async function handleOrderSync(
  db: Database,
  job: ClaimedJob,
  deps: DispatchDependencies,
): Promise<JobResult> {
  const externalOrderId = asString(job.payload['externalOrderId']);
  const source = asSource(job.payload['source']);
  const origin = orderOrigin(job.payload['noticedAt']);

  if (externalOrderId === null || job.businessId === null || job.connectionId === null) {
    return {
      status: 'failed',
      failureKind: 'malformed_job',
      detail: 'this order job names no order',
      retryable: false,
    };
  }

  const adapter = await deps.adapterFor(job.connectionId);
  const fetched = await adapter.fetchOrder(externalOrderId);

  if (fetched.status !== 'success') {
    return orderFetchFailure(fetched);
  }

  const order = fetched.value as NormalizedOrder;

  const identity = {
    connectionId: job.connectionId,
    businessId: job.businessId,
    provider: adapter.capabilities.provider,
    source,
    resourceType: 'order',
    resourceId: externalOrderId,
    // No provider event id: the identity of this work is the state we just
    // read, not the notification that prompted the read. Two notifications
    // about one unchanged order fingerprint identically and collapse, which is
    // exactly what section 15's coalescing asks for.
    payload: order,
  };

  const common = {
    businessId: job.businessId,
    connectionId: job.connectionId,
    externalOrderId,
  };

  return db.transaction(async (tx) => {
    // Always import first. Section 15: every line is recorded for operational
    // visibility, whatever state the order is in and whether or not anything
    // can be done about it.
    const ingested = await ingestOrder(tx, {
      ...common,
      order,
      changeOrigin: origin,
      event: { ...identity, eventType: 'order.state' },
    });

    if (ingested.outcome === 'already_processed') {
      return { status: 'done' };
    }

    switch (order.demandState) {
      case 'fulfilled':
        await applyFulfillment(tx, {
          ...common,
          changeOrigin: origin,
          event: { ...identity, eventType: 'order.fulfilled' },
          reason: 'the channel reports this order as fulfilled',
          ...shippedQuantities(order),
        });
        break;

      case 'cancelled':
        await applyCancellation(tx, {
          ...common,
          changeOrigin: origin,
          event: { ...identity, eventType: 'order.cancelled' },
          reason: 'the channel reports this order as cancelled',
        });
        break;

      case 'refunded':
        await applyRefund(tx, {
          ...common,
          changeOrigin: origin,
          event: { ...identity, eventType: 'order.refunded' },
          reason: 'the channel reports this order as refunded',
        });
        break;

      case 'awaiting':
      case 'committed':
        // Both are fully handled by the import above: `awaiting` moves nothing,
        // and `committed` reserved or consumed on its first qualifying pass.
        break;
    }

    return { status: 'done' };
  });
}

/**
 * Sweeps orders changed since the last watermark, with overlap.
 *
 * Section 15's incremental poll. It queues rather than processes: the poll's
 * job is to notice, and noticing should not be slowed by the work it finds. It
 * also means a poll that dies halfway has still queued what it saw, and the
 * watermark it did not advance simply causes the rest to be seen again.
 */
export async function handleOrderPoll(
  db: Database,
  job: ClaimedJob,
  deps: DispatchDependencies,
): Promise<JobResult> {
  if (job.businessId === null || job.connectionId === null) {
    return {
      status: 'failed',
      failureKind: 'malformed_job',
      detail: 'this poll job names no connection',
      retryable: false,
    };
  }

  const watermark = await readWatermark(db, job.connectionId);
  const since = new Date(watermark.getTime() - POLL_OVERLAP_MS);
  const adapter = await deps.adapterFor(job.connectionId);

  let cursor: string | undefined;
  let seen = 0;
  const startedAt = new Date();

  do {
    const page = await adapter.listChangedOrders({
      since,
      ...(cursor === undefined ? {} : { cursor }),
    });

    if (page.status !== 'success') {
      return toJobFailure(page);
    }

    for (const ref of page.value.items) {
      await requestOrderSync(db, {
        businessId: job.businessId,
        connectionId: job.connectionId,
        externalOrderId: ref.externalOrderId,
        source: 'poll',
      });
      seen += 1;
    }

    cursor = page.value.nextCursor;
  } while (cursor !== undefined);

  // Advanced only after the whole sweep succeeded, and to when the sweep
  // started rather than to now: an order changed while the pages were being
  // read must be caught by the next pass, not skipped by a watermark that
  // moved past it.
  await writeWatermark(db, {
    businessId: job.businessId,
    connectionId: job.connectionId,
    at: startedAt,
    seen,
  });

  return { status: 'done' };
}

async function readWatermark(db: Database, connectionId: string): Promise<Date> {
  const [row] = await db
    .select({ cursorValue: connectionCursors.cursorValue })
    .from(connectionCursors)
    .where(
      and(
        eq(connectionCursors.connectionId, connectionId),
        eq(connectionCursors.stream, ORDER_STREAM),
      ),
    )
    .limit(1);

  const stored = row?.cursorValue;
  if (stored === undefined || stored === null) {
    // No watermark yet. Section 15's startup recovery polls "recent orders with
    // the normal overlap window", so a first run reaches back one window rather
    // than attempting the whole history of the store.
    return new Date(Date.now() - POLL_OVERLAP_MS);
  }

  const parsed = new Date(stored);

  return Number.isNaN(parsed.getTime()) ? new Date(Date.now() - POLL_OVERLAP_MS) : parsed;
}

async function writeWatermark(
  db: Database,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly at: Date;
    readonly seen: number;
  },
): Promise<void> {
  await db
    .insert(connectionCursors)
    .values({
      businessId: input.businessId,
      connectionId: input.connectionId,
      stream: ORDER_STREAM,
      cursorValue: input.at.toISOString(),
      checkpoint: { lastSweepSeen: input.seen },
      lastCompleteAt: input.at,
    })
    .onConflictDoUpdate({
      target: [connectionCursors.connectionId, connectionCursors.stream],
      set: {
        cursorValue: input.at.toISOString(),
        checkpoint: { lastSweepSeen: input.seen },
        lastCompleteAt: input.at,
      },
    });
}

/**
 * A fetch that could not find the order.
 *
 * Not retryable and not an error: an order can be deleted, and a cancellation
 * webhook for an order the provider has since removed is a real sequence. There
 * is nothing to import and nothing to fix.
 */
function orderFetchFailure(failure: ProviderFailure): JobResult {
  if (failure.status === 'not_found') {
    return { status: 'superseded', detail: describeFailure(failure) };
  }

  return toJobFailure(failure);
}

function shippedQuantities(order: NormalizedOrder): {
  readonly shippedQuantities?: Record<string, number>;
} {
  const shipped: Record<string, number> = {};

  for (const line of order.lines) {
    if (line.shippedQuantity !== undefined && line.shippedQuantity > 0) {
      shipped[line.externalLineId] = line.shippedQuantity;
    }
  }

  return Object.keys(shipped).length === 0 ? {} : { shippedQuantities: shipped };
}

/**
 * Recovers section 1's clock from the job that carried it.
 *
 * Falls back to now for a job queued before this field existed, and for one
 * whose payload has been tampered with. Both cases understate the latency of
 * that single change rather than overstating it, which is the right direction
 * for a fallback to be wrong in: it can make one sample look fast, and it cannot
 * invent a delay that did not happen.
 */
function orderOrigin(value: unknown): ChangeOrigin {
  if (typeof value === 'string') {
    const noticedAt = new Date(value);

    if (!Number.isNaN(noticedAt.getTime())) {
      return { kind: 'order', noticedAt };
    }
  }

  return { kind: 'order', noticedAt: new Date() };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

const sources: readonly EventSource[] = [
  'webhook',
  'poll',
  'verification',
  'manual',
  'reconciliation',
];

function asSource(value: unknown): EventSource {
  return sources.find((source) => source === value) ?? 'poll';
}
