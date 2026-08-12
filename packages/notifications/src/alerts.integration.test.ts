import { alertStateAt, businesses, operatorAlerts, users, type OperatorAlert } from '@eim/db';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acknowledgeAlert,
  alertsDueForReminder,
  nextReminderAt,
  openAlerts,
  openInstallationAlerts,
  raiseAlert,
  recordNotified,
  resolveAlert,
  resolveAlertsAbout,
  snoozeAlert,
  REMINDER_GAPS_MS,
  REPEAT_REMINDER_GAP_MS,
} from './alerts';

/**
 * The life of an alert (section 22).
 *
 * What is worth proving is the restraint, and then the distance between an
 * acknowledgement and a resolution. A system that sends one message per
 * occurrence has not informed anybody; one that treats a click as proof of
 * recovery reports good news it has no evidence for.
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

async function read(alertId: string): Promise<OperatorAlert> {
  const [row] = await harness.db
    .select()
    .from(operatorAlerts)
    .where(eq(operatorAlerts.id, alertId));

  return row!;
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
      recommendedAction: 'reconnect the store',
    });

    const [alert] = await openAlerts(harness.db, businessId);
    expect(alert?.summary).toBe('the credentials were rejected');
    expect(alert?.recommendedAction).toBe('reconnect the store');
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
    expect(alert?.severityRank).toBe(4);
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

  it('treats a new state version as a new problem', async () => {
    // Section 22 deduplicates on the state version too: drift measured against
    // a newer desired quantity is not the drift somebody already looked at.
    const { businessId } = await seed();

    await raiseAlert(harness.db, {
      businessId,
      kind: 'unsafe_drift',
      subjectKey: 'mapping:one',
      stateVersion: '41',
      summary: 'the channel disagrees',
    });
    await raiseAlert(harness.db, {
      businessId,
      kind: 'unsafe_drift',
      subjectKey: 'mapping:one',
      stateVersion: '42',
      summary: 'the channel disagrees',
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

  it('deduplicates installation alerts, which belong to no business', async () => {
    // Two nulls are distinct values under the default, so without
    // `nulls not distinct` every check of a stalled queue would file another
    // copy of the same complaint.
    const first = await raiseAlert(harness.db, {
      kind: 'queue_stalled',
      severity: 'error',
      subjectKey: 'queue:default',
      summary: 'the queue has stopped draining',
    });
    const second = await raiseAlert(harness.db, {
      kind: 'queue_stalled',
      severity: 'error',
      subjectKey: 'queue:default',
      summary: 'the queue has stopped draining',
    });

    expect(second.alertId).toBe(first.alertId);
    expect(second.occurrences).toBe(2);

    const installation = await openInstallationAlerts(harness.db);
    expect(installation.map((alert) => alert.id)).toContain(first.alertId);
    expect(installation.every((alert) => alert.scope === 'installation')).toBe(true);

    await resolveAlert(harness.db, {
      alertId: first.alertId,
      evidence: { drained: true },
    });
  });

  it('refuses to file an installation problem under a business', async () => {
    const { businessId } = await seed();

    expect(
      await refuses(() =>
        raiseAlert(harness.db, {
          businessId,
          kind: 'disk_pressure',
          subjectKey: 'volume:data',
          summary: 'nearly full',
        }),
      ),
    ).toMatch(/operator_alerts_scope_matches_kind/u);
  });

  it('refuses to let a business problem escape into the installation list', async () => {
    expect(
      await refuses(() =>
        raiseAlert(harness.db, {
          kind: 'oversold',
          subjectKey: 'item:one',
          summary: 'short',
        }),
      ),
    ).toMatch(/operator_alerts_scope_matches_kind/u);
  });
});

describe('acknowledgeAlert', () => {
  it('stops the reminders without hiding the problem', async () => {
    // Section 22: acknowledgement "suppresses ordinary repeats without hiding
    // ongoing state". The alert stays in the list and keeps counting.
    const { businessId, userId } = await seed();

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      severity: 'error',
      subjectKey: 'connection:one',
      summary: 'the store is not answering',
    });

    await recordNotified(harness.db, alert.alertId, new Date());
    expect((await read(alert.alertId)).nextReminderAt).not.toBeNull();

    expect(
      await acknowledgeAlert(harness.db, {
        businessId,
        alertId: alert.alertId,
        actorUserId: userId,
        note: 'restarted the host',
      }),
    ).toBe(true);

    const acknowledged = await read(alert.alertId);
    expect(acknowledged.nextReminderAt).toBeNull();
    expect(acknowledged.acknowledgementNote).toBe('restarted the host');
    expect(alertStateAt(acknowledged, new Date())).toBe('acknowledged');

    // Still outstanding, and a further occurrence still lands on the same row.
    expect(await openAlerts(harness.db, businessId)).toHaveLength(1);

    const again = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      severity: 'error',
      subjectKey: 'connection:one',
      summary: 'the store is not answering',
    });
    expect(again.alertId).toBe(alert.alertId);
    expect(again.occurrences).toBe(2);
  });

  it('speaks up immediately when an acknowledged problem gets worse', async () => {
    // Section 22: "material severity changes notify immediately."
    const { businessId, userId } = await seed();

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      severity: 'error',
      subjectKey: 'connection:one',
      summary: 'the store answered slowly',
    });
    await recordNotified(harness.db, alert.alertId, new Date());
    await acknowledgeAlert(harness.db, {
      businessId,
      alertId: alert.alertId,
      actorUserId: userId,
    });

    const worse = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      severity: 'critical',
      subjectKey: 'connection:one',
      summary: 'the store is not answering at all',
    });

    expect(worse.severityEscalated).toBe(true);
    expect((await read(alert.alertId)).nextReminderAt).not.toBeNull();
  });

  it('reports an alert that has already been resolved', async () => {
    const { businessId, userId } = await seed();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      subjectKey: 'item:one',
      summary: 'short',
    });

    await resolveAlert(harness.db, {
      businessId,
      alertId: alert.alertId,
      evidence: { rechecked: true, shortage: 0 },
    });

    expect(
      await acknowledgeAlert(harness.db, {
        businessId,
        alertId: alert.alertId,
        actorUserId: userId,
      }),
    ).toBe(false);
  });
});

describe('snoozeAlert', () => {
  it('goes quiet until the time passes, then is due again', async () => {
    const { businessId, userId } = await seed();
    const now = new Date();

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'restock_pending',
      severity: 'error',
      subjectKey: 'item:one',
      summary: 'waiting to go back on sale',
    });
    await recordNotified(
      harness.db,
      alert.alertId,
      new Date(now.getTime() - REPEAT_REMINDER_GAP_MS),
    );

    const until = new Date(now.getTime() + 60 * 60_000);
    expect(
      await snoozeAlert(harness.db, {
        businessId,
        alertId: alert.alertId,
        actorUserId: userId,
        until,
        now,
      }),
    ).toBe(true);

    expect(alertStateAt(await read(alert.alertId), now)).toBe('snoozed');

    // Due, but silent, until the snooze lapses.
    const duringSnooze = await alertsDueForReminder(harness.db, now);
    expect(duringSnooze.map((row) => row.id)).not.toContain(alert.alertId);

    const afterSnooze = await alertsDueForReminder(harness.db, new Date(until.getTime() + 1000));
    expect(afterSnooze.map((row) => row.id)).toContain(alert.alertId);
  });

  it('refuses a snooze that has already expired', async () => {
    const { businessId, userId } = await seed();
    const now = new Date();

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'restock_pending',
      subjectKey: 'item:one',
      summary: 'waiting',
    });

    expect(
      await snoozeAlert(harness.db, {
        businessId,
        alertId: alert.alertId,
        actorUserId: userId,
        until: new Date(now.getTime() - 1),
        now,
      }),
    ).toBe(false);
  });
});

describe('resolving', () => {
  it('requires evidence that the problem is gone', async () => {
    const { businessId } = await seed();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      subjectKey: 'connection:one',
      summary: 'not answering',
    });

    // The database, not the caller, is what makes this true: a resolution
    // without evidence is indistinguishable from a guess.
    expect(
      await refuses(() =>
        harness.db
          .update(operatorAlerts)
          .set({ resolvedAt: new Date() })
          .where(eq(operatorAlerts.id, alert.alertId)),
      ),
    ).toMatch(/operator_alerts_resolution_has_evidence/u);
  });

  it('lets a fresh check close what it was about, and the problem reopen later', async () => {
    const { businessId } = await seed();

    const first = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      subjectKey: 'connection:one',
      summary: 'not answering',
    });

    expect(
      await resolveAlertsAbout(harness.db, {
        businessId,
        kind: 'connection_unhealthy',
        subjectKey: 'connection:one',
        evidence: { checkedAt: new Date().toISOString(), reachable: true },
      }),
    ).toBe(1);

    expect(await openAlerts(harness.db, businessId)).toHaveLength(0);
    expect(alertStateAt(await read(first.alertId), new Date())).toBe('resolved');

    // The same problem later is a new alert, because the old one has a proven
    // end. The history of both survives.
    const again = await raiseAlert(harness.db, {
      businessId,
      kind: 'connection_unhealthy',
      subjectKey: 'connection:one',
      summary: 'not answering',
    });
    expect(again.alertId).not.toBe(first.alertId);
    expect(again.isNew).toBe(true);
  });

  it('resolves nothing when nothing was wrong', async () => {
    const { businessId } = await seed();

    expect(
      await resolveAlertsAbout(harness.db, {
        businessId,
        kind: 'connection_unhealthy',
        subjectKey: 'connection:never-complained',
        evidence: { reachable: true },
      }),
    ).toBe(0);
  });
});

describe('reminder schedule', () => {
  it('follows fifteen minutes, an hour, four hours, then daily', async () => {
    const { businessId } = await seed();
    const start = new Date('2026-03-01T09:00:00.000Z');

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    const cumulative: number[] = [];
    let at = start;
    for (let pass = 0; pass < 5; pass += 1) {
      await recordNotified(harness.db, alert.alertId, at);
      const due = (await read(alert.alertId)).nextReminderAt!;
      cumulative.push(due.getTime() - start.getTime());
      at = due;
    }

    const minutes = cumulative.map((ms) => ms / 60_000);
    expect(minutes).toEqual([15, 60, 240, 240 + 1440, 240 + 2880]);
    expect((await read(alert.alertId)).remindersSent).toBe(4);
  });

  it('does not remind about the merely noteworthy', async () => {
    // Section 22 reminds about Error and Critical. A Warning that repeated
    // every fifteen minutes would teach people to ignore the channel Critical
    // also arrives on.
    const { businessId } = await seed();

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'restock_pending',
      severity: 'warning',
      subjectKey: 'item:one',
      summary: 'waiting',
    });

    await recordNotified(harness.db, alert.alertId, new Date());
    expect((await read(alert.alertId)).nextReminderAt).toBeNull();
  });

  it('agrees with the pure schedule', () => {
    const at = new Date('2026-03-01T09:00:00.000Z');

    expect(nextReminderAt(0, at).getTime() - at.getTime()).toBe(REMINDER_GAPS_MS[0]);
    expect(nextReminderAt(REMINDER_GAPS_MS.length, at).getTime() - at.getTime()).toBe(
      REPEAT_REMINDER_GAP_MS,
    );
  });
});
