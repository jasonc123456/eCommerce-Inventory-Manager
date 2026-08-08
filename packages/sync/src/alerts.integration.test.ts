import { businesses, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acknowledgeAlert, openAlerts, raiseAlert } from './alerts';

/**
 * Operator alerts (sections 11, 12, 22).
 *
 * What is worth proving is the restraint. A system that sends one message per
 * occurrence has not informed anybody — it has made the real alerts
 * unfindable — and an acknowledgement that silenced a class of problem would
 * be worse still.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(): Promise<{ businessId: string; userId: string }> {
  const slug = `alert-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });

  return { businessId: business!.id, userId: user!.id };
}

describe('raiseAlert', () => {
  it('collapses repeats of one problem into one thing to deal with', async () => {
    const { businessId } = await seed();

    const raised = [];
    for (let pass = 0; pass < 20; pass += 1) {
      raised.push(
        await raiseAlert(harness.db, {
          businessId,
          kind: 'mapping_blocked',
          subjectKey: 'mapping:one',
          summary: 'this mapping has stopped synchronizing',
        }),
      );
    }

    expect(new Set(raised.map((alert) => alert.alertId)).size).toBe(1);
    expect(raised[0]?.isNew).toBe(true);
    expect(raised[19]?.occurrences).toBe(20);
    expect(await openAlerts(harness.db, businessId)).toHaveLength(1);
  });

  it('keeps the newest wording', async () => {
    // A blocked mapping whose reason changed from a rate limit to a rejected
    // credential is still one alert, and the reason a person reads should be
    // the current one.
    const { businessId } = await seed();

    await raiseAlert(harness.db, {
      businessId,
      kind: 'mapping_blocked',
      subjectKey: 'mapping:one',
      summary: 'rate limited',
    });
    await raiseAlert(harness.db, {
      businessId,
      kind: 'mapping_blocked',
      subjectKey: 'mapping:one',
      summary: 'the credentials were rejected',
    });

    const [alert] = await openAlerts(harness.db, businessId);
    expect(alert?.summary).toBe('the credentials were rejected');
  });

  it('never quietly downgrades how serious something is', async () => {
    const { businessId } = await seed();

    await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      severity: 'critical',
      subjectKey: 'connection:one',
      summary: 'the store is not answering',
    });
    await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      severity: 'info',
      subjectKey: 'connection:one',
      summary: 'the store answered slowly',
    });

    const [alert] = await openAlerts(harness.db, businessId);
    expect(alert?.severity).toBe('critical');
  });

  it('keeps separate problems separate', async () => {
    const { businessId } = await seed();

    await raiseAlert(harness.db, {
      businessId,
      kind: 'mapping_blocked',
      subjectKey: 'mapping:one',
      summary: 'blocked',
    });
    await raiseAlert(harness.db, {
      businessId,
      kind: 'mapping_blocked',
      subjectKey: 'mapping:two',
      summary: 'blocked',
    });

    expect(await openAlerts(harness.db, businessId)).toHaveLength(2);
  });

  it('does not leak an alert across businesses', async () => {
    const mine = await seed();
    const theirs = await seed();

    await raiseAlert(harness.db, {
      businessId: mine.businessId,
      kind: 'oversold',
      subjectKey: 'item:one',
      summary: 'short',
    });

    expect(await openAlerts(harness.db, theirs.businessId)).toHaveLength(0);
  });
});

describe('acknowledgeAlert', () => {
  it('closes one alert and lets the problem come back as a new one', async () => {
    // The asymmetry is the point. Acknowledging "the store was down this
    // morning" must not silence the same store going down this afternoon.
    const { businessId, userId } = await seed();

    const first = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      subjectKey: 'connection:one',
      summary: 'the store is not answering',
    });

    expect(
      await acknowledgeAlert(harness.db, {
        businessId,
        alertId: first.alertId,
        actorUserId: userId,
        note: 'restarted the host',
      }),
    ).toBe(true);
    expect(await openAlerts(harness.db, businessId)).toHaveLength(0);

    const again = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      subjectKey: 'connection:one',
      summary: 'the store is not answering',
    });

    expect(again.alertId).not.toBe(first.alertId);
    expect(again.isNew).toBe(true);
    expect(await openAlerts(harness.db, businessId)).toHaveLength(1);
  });

  it('reports an alert somebody else already dealt with', async () => {
    const { businessId, userId } = await seed();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      subjectKey: 'item:one',
      summary: 'short',
    });

    await acknowledgeAlert(harness.db, { businessId, alertId: alert.alertId, actorUserId: userId });

    expect(
      await acknowledgeAlert(harness.db, {
        businessId,
        alertId: alert.alertId,
        actorUserId: userId,
      }),
    ).toBe(false);
  });
});
