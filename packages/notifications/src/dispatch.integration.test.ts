import { businesses, notificationDeliveries, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { raiseAlert } from './alerts';
import {
  claimDueDeliveries,
  deliveriesFor,
  deliveryKey,
  hasBeenNotified,
  markDelivered,
  markFailed,
  recordDeliveries,
  recordSuppressed,
  MAX_DELIVERY_ATTEMPTS,
} from './dispatch';
import type { Delivery } from './routing';

/**
 * Sending, and being able to say what was sent (sections 20, 22).
 *
 * Sending is the one part of notification that cannot be undone, so the two
 * properties worth proving are that a repeat does not send twice and that a
 * failure is bounded rather than retried forever at somebody's mail server.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(): Promise<{ businessId: string; userId: string; alertId: string }> {
  const slug = `dispatch-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });

  const alert = await raiseAlert(harness.db, {
    businessId: business!.id,
    kind: 'oversold',
    severity: 'critical',
    subjectKey: `item:${slug}`,
    summary: 'an order could not be filled in full',
  });

  return { businessId: business!.id, userId: user!.id, alertId: alert.alertId };
}

function bothChannels(userId: string, deferUntil: Date | null = null): Delivery[] {
  return [
    {
      userId,
      email: 'operator@example.invalid',
      channels: ['in_app', 'email'],
      deferUntil,
    },
  ];
}

describe('deliveryKey', () => {
  it('is the same for a retry and different for a reminder', () => {
    const base = {
      alertId: 'a',
      channel: 'email' as const,
      recipientUserId: 'u',
      remindersSent: 0,
    };

    expect(deliveryKey(base)).toBe(deliveryKey({ ...base }));
    expect(deliveryKey(base)).not.toBe(deliveryKey({ ...base, remindersSent: 1 }));
    expect(deliveryKey(base)).not.toBe(deliveryKey({ ...base, channel: 'in_app' }));
    expect(deliveryKey(base)).not.toBe(deliveryKey({ ...base, recipientUserId: 'v' }));
  });
});

describe('recordDeliveries', () => {
  it('writes the intent down before anything is sent', async () => {
    const { businessId, userId, alertId } = await seed();

    const written = await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: bothChannels(userId),
    });

    expect(written).toHaveLength(2);
    expect(written.find((row) => row.channel === 'email')?.status).toBe('pending');
    // Nothing is transmitted for the in-app channel: the row is the notification.
    expect(written.find((row) => row.channel === 'in_app')?.status).toBe('sent');
  });

  it('does not send twice when a sweep runs twice', async () => {
    const { businessId, userId, alertId } = await seed();
    const input = { businessId, alertId, remindersSent: 0, deliveries: bothChannels(userId) };

    await recordDeliveries(harness.db, input);
    const second = await recordDeliveries(harness.db, input);

    expect(second).toHaveLength(0);
    expect(await deliveriesFor(harness.db, alertId)).toHaveLength(2);
  });

  it('treats a reminder as a new message', async () => {
    const { businessId, userId, alertId } = await seed();

    await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: bothChannels(userId),
    });
    const reminder = await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 1,
      deliveries: bothChannels(userId),
    });

    expect(reminder).toHaveLength(2);
  });

  it('holds a deferred message rather than dropping it', async () => {
    const { businessId, userId, alertId } = await seed();
    const until = new Date(Date.now() + 60 * 60_000);

    const written = await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: bothChannels(userId, until),
    });

    const email = written.find((row) => row.channel === 'email');
    expect(email?.status).toBe('deferred');
    expect(email?.deferredUntil?.toISOString()).toBe(until.toISOString());
  });

  it('records a decision not to send, rather than leaving a gap', async () => {
    const { businessId, userId, alertId } = await seed();

    await recordSuppressed(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: bothChannels(userId),
      reason: 'the alert was acknowledged before the reminder came due',
    });

    const history = await deliveriesFor(harness.db, alertId);
    expect(history).toHaveLength(2);
    expect(history.every((row) => row.status === 'suppressed')).toBe(true);
    expect(history[0]?.failureReason).toContain('acknowledged');
  });
});

describe('claimDueDeliveries', () => {
  it('claims what is owed and counts the attempt before making it', async () => {
    const { businessId, userId, alertId } = await seed();
    const now = new Date();

    await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: bothChannels(userId),
    });

    const claimed = await claimDueDeliveries(harness.db, 'email', now);
    const mine = claimed.filter((row) => row.alertId === alertId);

    expect(mine).toHaveLength(1);
    expect(mine[0]?.attempts).toBe(1);
    expect(mine[0]?.lastAttemptAt).not.toBeNull();
  });

  it('leaves a deferred message alone until its time', async () => {
    const { businessId, userId, alertId } = await seed();
    const until = new Date(Date.now() + 60 * 60_000);

    await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: bothChannels(userId, until),
    });

    const early = await claimDueDeliveries(harness.db, 'email', new Date());
    expect(early.map((row) => row.alertId)).not.toContain(alertId);

    const late = await claimDueDeliveries(harness.db, 'email', new Date(until.getTime() + 1000));
    expect(late.map((row) => row.alertId)).toContain(alertId);
  });
});

describe('the outcome of a send', () => {
  it('records that it went out', async () => {
    const { businessId, userId, alertId } = await seed();
    const [claimed] = await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: [{ userId, email: 'x@example.invalid', channels: ['email'], deferUntil: null }],
    });

    expect(await hasBeenNotified(harness.db, alertId, 'email')).toBe(false);
    await markDelivered(harness.db, claimed!.id, new Date());
    expect(await hasBeenNotified(harness.db, alertId, 'email')).toBe(true);
  });

  it('gives up rather than retrying a broken address into the evening', async () => {
    const { businessId, userId, alertId } = await seed();
    const [row] = await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: [{ userId, email: 'x@example.invalid', channels: ['email'], deferUntil: null }],
    });

    const outcomes: string[] = [];
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      await claimDueDeliveries(harness.db, 'email', new Date());
      outcomes.push(await markFailed(harness.db, row!.id, 'the relay refused the recipient'));
    }

    expect(outcomes.at(-1)).toBe('failed');
    expect(outcomes.slice(0, -1).every((outcome) => outcome === 'retrying')).toBe(true);

    // And once it has failed, no sweep picks it up again.
    const claimed = await claimDueDeliveries(harness.db, 'email', new Date());
    expect(claimed.map((delivery) => delivery.id)).not.toContain(row!.id);
  });

  it('will not record a failure without saying why', async () => {
    const { businessId, userId, alertId } = await seed();
    const [row] = await recordDeliveries(harness.db, {
      businessId,
      alertId,
      remindersSent: 0,
      deliveries: [{ userId, email: 'x@example.invalid', channels: ['email'], deferUntil: null }],
    });

    // Reaching the ceiling with no reason is refused by the database: a failure
    // that says only "something went wrong" tells the operator what they knew.
    await harness.db
      .update(notificationDeliveries)
      .set({ attempts: MAX_DELIVERY_ATTEMPTS })
      .where(eq(notificationDeliveries.id, row!.id));

    await expect(
      harness.db
        .update(notificationDeliveries)
        .set({ status: 'failed', failureReason: null })
        .where(eq(notificationDeliveries.id, row!.id)),
    ).rejects.toThrow();
  });
});
