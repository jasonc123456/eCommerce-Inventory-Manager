import { createHash } from 'node:crypto';

import {
  notificationDeliveries,
  type Database,
  type NotificationChannelName,
  type NotificationDelivery,
} from '@eim/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Delivery } from './routing';

/**
 * Turning a decision into something that was actually sent (sections 20, 22).
 *
 * The order is the whole design: the intent is written down before anything is
 * sent, and the send updates the row it already has. Recording success
 * afterwards would lose the two cases worth keeping — the crash between sending
 * and writing, and the send that hung — and both of those look identical to
 * "never attempted" in a table that only records what worked.
 *
 * Idempotency is a derived key rather than a counter. The same notification,
 * computed twice, produces the same string, and a unique index turns the second
 * write into a no-op. Nothing here has to remember whether it has run, which
 * matters because the thing most likely to run twice is a sweep that crashed
 * halfway.
 */

/** Section 22 bounds retries. Five attempts over a widening back-off is enough
 * to survive a relay restart and short enough that a broken address is reported
 * rather than retried into the evening. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * The identity of one notification.
 *
 * Includes the reminder count, so the fifteen-minute reminder about an alert is
 * a different message from the first notification about it, while a retry of
 * either is the same message. Hashed rather than concatenated because the parts
 * are identifiers of varying length and a delimiter collision would silently
 * merge two notifications into one.
 */
export function deliveryKey(input: {
  readonly alertId: string;
  readonly channel: NotificationChannelName;
  readonly recipientUserId: string | null;
  readonly remindersSent: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([input.alertId, input.channel, input.recipientUserId, input.remindersSent]),
    )
    .digest('base64url');
}

export interface RecordDeliveriesInput {
  readonly businessId?: string;
  readonly alertId: string;
  readonly remindersSent: number;
  readonly deliveries: readonly Delivery[];
}

/**
 * Writes down what is about to be sent.
 *
 * Returns the rows that are genuinely new. A repeat pass returns nothing, which
 * is how a caller can tell a first notification from a retry without asking a
 * second question.
 */
export async function recordDeliveries(
  db: Database,
  input: RecordDeliveriesInput,
): Promise<NotificationDelivery[]> {
  const rows = input.deliveries.flatMap((delivery) =>
    delivery.channels.map((channel) => ({
      ...(input.businessId === undefined ? {} : { businessId: input.businessId }),
      alertId: input.alertId,
      channel,
      recipientUserId: delivery.userId,
      idempotencyKey: deliveryKey({
        alertId: input.alertId,
        channel,
        recipientUserId: delivery.userId,
        remindersSent: input.remindersSent,
      }),
      // The in-app entry is complete the moment it is written — there is
      // nothing to transmit, and the row *is* the notification.
      ...(channel === 'in_app'
        ? { status: 'sent' as const, sentAt: new Date() }
        : delivery.deferUntil === null
          ? { status: 'pending' as const }
          : { status: 'deferred' as const, deferredUntil: delivery.deferUntil }),
    })),
  );

  if (rows.length === 0) {
    return [];
  }

  return db.insert(notificationDeliveries).values(rows).onConflictDoNothing().returning();
}

/**
 * Records that nothing will be sent, and why.
 *
 * Section 22 wants a delivery history, and a history with a gap in it is one
 * that cannot answer the question people actually ask after an incident, which
 * is why nobody was told rather than who was.
 */
export async function recordSuppressed(
  db: Database,
  input: RecordDeliveriesInput & { readonly reason: string },
): Promise<void> {
  const rows = input.deliveries.flatMap((delivery) =>
    delivery.channels.map((channel) => ({
      ...(input.businessId === undefined ? {} : { businessId: input.businessId }),
      alertId: input.alertId,
      channel,
      recipientUserId: delivery.userId,
      idempotencyKey: deliveryKey({
        alertId: input.alertId,
        channel,
        recipientUserId: delivery.userId,
        remindersSent: input.remindersSent,
      }),
      status: 'suppressed' as const,
      failureReason: input.reason,
    })),
  );

  if (rows.length > 0) {
    await db.insert(notificationDeliveries).values(rows).onConflictDoNothing();
  }
}

/**
 * Claims the messages that are owed, and counts the attempt before making it.
 *
 * `for update skip locked` so two workers sweeping at once divide the work
 * rather than duplicating it, and the attempt is counted on the way out rather
 * than on the way back: a process that dies mid-send must not leave a row that
 * looks untried, or a permanently failing address becomes an infinite loop with
 * a mail server on the other end of it.
 */
export async function claimDueDeliveries(
  db: Database,
  channel: NotificationChannelName,
  now: Date,
  limit = 50,
): Promise<NotificationDelivery[]> {
  const claimed = await db.execute<{ id: string }>(sql`
    update notification_deliveries set
      status = 'pending',
      attempts = attempts + 1,
      last_attempt_at = ${now}::timestamptz
    where id in (
      select id from notification_deliveries
       where channel = ${channel}
         and attempts < ${MAX_DELIVERY_ATTEMPTS}
         and (status = 'pending'
              or (status = 'deferred' and deferred_until <= ${now}::timestamptz))
       order by created_at
       for update skip locked
       limit ${limit}
    )
    returning id
  `);

  const ids = claimed.rows.map((row) => row.id);

  if (ids.length === 0) {
    return [];
  }

  return db.select().from(notificationDeliveries).where(inArray(notificationDeliveries.id, ids));
}

/** It went out. */
export async function markDelivered(db: Database, deliveryId: string, at: Date): Promise<void> {
  await db
    .update(notificationDeliveries)
    .set({ status: 'sent', sentAt: at, failureReason: null })
    .where(eq(notificationDeliveries.id, deliveryId));
}

/**
 * It did not go out.
 *
 * A row that still has attempts left goes back to pending and will be tried
 * again; one that has run out is marked failed and stops. The reason is a short
 * description written by the caller, never the transport's own error, which
 * routinely quotes the envelope and sometimes the body back at you.
 */
export async function markFailed(
  db: Database,
  deliveryId: string,
  reason: string,
): Promise<'retrying' | 'failed'> {
  const rows = await db
    .update(notificationDeliveries)
    .set({
      status: sql`case when attempts >= ${MAX_DELIVERY_ATTEMPTS} then 'failed' else 'pending' end`,
      failureReason: reason.slice(0, 500),
    })
    .where(eq(notificationDeliveries.id, deliveryId))
    .returning({ status: notificationDeliveries.status });

  return rows[0]?.status === 'failed' ? 'failed' : 'retrying';
}

/** What was sent about one alert, most recent first. */
export async function deliveriesFor(
  db: Database,
  alertId: string,
  limit = 50,
): Promise<NotificationDelivery[]> {
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.alertId, alertId))
    .orderBy(sql`created_at desc`)
    .limit(limit);
}

/** Whether anything has already been sent about this alert on this channel. */
export async function hasBeenNotified(
  db: Database,
  alertId: string,
  channel: NotificationChannelName,
): Promise<boolean> {
  const rows = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.alertId, alertId),
        eq(notificationDeliveries.channel, channel),
        eq(notificationDeliveries.status, 'sent'),
      ),
    )
    .limit(1);

  return rows.length === 1;
}
