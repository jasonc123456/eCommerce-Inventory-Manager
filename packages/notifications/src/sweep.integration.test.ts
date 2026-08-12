import { businesses, memberships, notificationDeliveries, users } from '@eim/db';
import type { DeliveryOutcome, Mailer, OutboundMessage } from '@eim/mail';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { acknowledgeAlert, raiseAlert } from './alerts';
import { savePreference, saveBusinessSettings } from './preferences';
import { announceNewAlerts, sendDueReminders, sendPendingEmail, type SweepPorts } from './sweep';

/**
 * The loop that actually tells somebody (section 22).
 *
 * End to end, against a real database and a mailer that records rather than
 * sends. What is worth proving is that the pieces compose the way each of them
 * claims: a permission gate that a preference cannot widen, an acknowledgement
 * that suppresses without hiding, quiet hours that hold a message, and a sweep
 * that can be run twice.
 */

let harness: TestDatabase;

class RecordingMailer implements Mailer {
  public readonly sent: OutboundMessage[] = [];
  /**
   * Refuse messages to one address.
   *
   * By address rather than by "the next one", because the sweep is
   * installation-wide and claims whatever is oldest — which, in a file where
   * every test shares a database, is regularly somebody else's message.
   */
  public failFor: string | null = null;

  send(message: OutboundMessage): Promise<DeliveryOutcome> {
    if (this.failFor === message.to) {
      return Promise.resolve({
        delivered: false,
        failure: { kind: 'connection', summary: 'the relay refused the connection' },
      });
    }

    this.sent.push(message);
    return Promise.resolve({ delivered: true, messageId: `id-${String(this.sent.length)}` });
  }

  verify(): Promise<DeliveryOutcome> {
    return Promise.resolve({ delivered: true, messageId: 'verify' });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

let mailer: RecordingMailer;

function ports(now?: Date): SweepPorts {
  return {
    db: harness.db,
    mailer,
    productName: 'Inventory Manager',
    publicUrl: 'https://inventory.example',
    ...(now === undefined ? {} : { now: () => now }),
  };
}

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

beforeEach(() => {
  mailer = new RecordingMailer();
});

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(options: { readonly owner?: boolean } = {}): Promise<{
  businessId: string;
  userId: string;
  email: string;
}> {
  const slug = `sweep-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Owner' })
    .returning({ id: users.id });

  await harness.db.insert(memberships).values({
    businessId: business!.id,
    userId: user!.id,
    role: options.owner === false ? 'operator' : 'owner',
    status: 'active',
  });

  return { businessId: business!.id, userId: user!.id, email: `${slug}@example.invalid` };
}

/**
 * Only this shop's messages.
 *
 * Every test in this file shares one database, and the sweep is deliberately
 * installation-wide: it announces every unnotified alert it can find. Counting
 * the mailer's whole outbox would therefore be counting the other tests, so
 * each assertion narrows to the address it seeded.
 */
function sentTo(email: string): OutboundMessage[] {
  return mailer.sent.filter((message) => message.to === email);
}

describe('announceNewAlerts', () => {
  it('tells the owner, in the application and by email', async () => {
    const { businessId, userId, email } = await seed();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'an order could not be filled in full',
    });

    const announced = await announceNewAlerts(ports());
    expect(announced.announced).toBeGreaterThanOrEqual(1);

    const rows = await harness.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.alertId, alert.alertId));

    expect(rows.map((row) => row.channel).sort()).toEqual(['email', 'in_app']);
    expect(rows.every((row) => row.recipientUserId === userId)).toBe(true);

    await sendPendingEmail(ports());
    expect(sentTo(email)).toHaveLength(1);
    expect(sentTo(email)[0]?.subject).toContain('[Critical]');
  });

  it('can be run twice without sending twice', async () => {
    // The property that matters for a process most likely to die halfway.
    const { businessId, email } = await seed();
    await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    await announceNewAlerts(ports());
    await announceNewAlerts(ports());
    await sendPendingEmail(ports());
    await sendPendingEmail(ports());

    expect(sentTo(email)).toHaveLength(1);
  });

  it('does not tell somebody the permission catalogue refused', async () => {
    // An operator with no grants holds nothing, so an oversell addressed to
    // `receive_critical_inventory_alerts` does not reach them.
    const { businessId } = await seed({ owner: false });
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    await announceNewAlerts(ports());

    const rows = await harness.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.alertId, alert.alertId));

    expect(rows).toHaveLength(0);
  });

  it('does not announce the same alert forever when nobody may hear it', async () => {
    // The alert is marked notified even with no audience, or the sweep spends
    // its whole budget on the one thing it can do nothing about.
    const { businessId } = await seed({ owner: false });
    await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    expect((await announceNewAlerts(ports())).considered).toBeGreaterThanOrEqual(1);
    expect((await announceNewAlerts(ports())).considered).toBe(0);
  });

  it('honours a preference that narrows the channel', async () => {
    const { businessId, userId } = await seed();
    await savePreference(harness.db, businessId, userId, { emailMinSeverity: 'none' });

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    await announceNewAlerts(ports());

    const rows = await harness.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.alertId, alert.alertId));

    expect(rows.map((row) => row.channel)).toEqual(['in_app']);
  });

  it('holds an ordinary alert through the shop’s quiet hours', async () => {
    const { businessId, email } = await seed();
    await saveBusinessSettings(harness.db, businessId, {
      quietHoursStart: '21:00',
      quietHoursEnd: '07:00',
    });

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'job_dead_lettered',
      severity: 'error',
      subjectKey: 'job:one',
      summary: 'a job gave up',
    });

    const night = new Date('2026-01-15T23:00:00.000Z');
    await announceNewAlerts(ports(night));

    const rows = await harness.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.alertId, alert.alertId));

    const deferred = rows.find((row) => row.channel === 'email');
    expect(deferred?.status).toBe('deferred');

    // Nothing goes out during the night...
    await sendPendingEmail(ports(night));
    expect(sentTo(email)).toHaveLength(0);

    // ...and it does in the morning.
    await sendPendingEmail(ports(new Date('2026-01-16T07:30:00.000Z')));
    expect(sentTo(email)).toHaveLength(1);
  });

  it('wakes somebody for stock being sold twice', async () => {
    const { businessId } = await seed();
    await saveBusinessSettings(harness.db, businessId, {
      quietHoursStart: '21:00',
      quietHoursEnd: '07:00',
    });

    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    await announceNewAlerts(ports(new Date('2026-01-15T23:00:00.000Z')));

    const rows = await harness.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.alertId, alert.alertId));

    expect(rows.find((row) => row.channel === 'email')?.status).toBe('pending');
  });
});

describe('sendDueReminders', () => {
  it('stops reminding once somebody says they have seen it', async () => {
    const { businessId, userId, email } = await seed();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    const start = new Date('2026-03-01T09:00:00.000Z');
    await announceNewAlerts(ports(start));
    await sendPendingEmail(ports(start));
    expect(sentTo(email)).toHaveLength(1);

    await acknowledgeAlert(harness.db, { businessId, alertId: alert.alertId, actorUserId: userId });

    // An acknowledgement clears the schedule, so the reminder never comes due.
    // The alert itself stays outstanding — it is quiet, not gone.
    await sendDueReminders(ports(new Date(start.getTime() + 16 * 60_000)));
    await sendPendingEmail(ports(new Date(start.getTime() + 16 * 60_000)));

    expect(sentTo(email)).toHaveLength(1);
  });

  it('reminds about an alert nobody has dealt with', async () => {
    const { businessId, email } = await seed();
    await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    const start = new Date('2026-03-01T09:00:00.000Z');
    await announceNewAlerts(ports(start));
    await sendPendingEmail(ports(start));
    expect(sentTo(email)).toHaveLength(1);

    const later = new Date(start.getTime() + 16 * 60_000);
    expect((await sendDueReminders(ports(later))).announced).toBeGreaterThanOrEqual(1);

    await sendPendingEmail(ports(later));
    expect(sentTo(email)).toHaveLength(2);
  });
});

describe('sendPendingEmail', () => {
  it('leaves the alerts alone when no relay is configured', async () => {
    // Marking every message failed would bury the real problem, which is that
    // nobody has configured SMTP.
    const { businessId } = await seed();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    await announceNewAlerts(ports());
    const result = await sendPendingEmail({ ...ports(), mailer: null });

    expect(result.considered).toBe(0);

    const rows = await harness.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.alertId, alert.alertId));

    expect(rows.find((row) => row.channel === 'email')?.status).toBe('pending');
  });

  it('records a refusal without quoting the relay back', async () => {
    const { businessId, email } = await seed();
    const alert = await raiseAlert(harness.db, {
      businessId,
      kind: 'oversold',
      severity: 'critical',
      subjectKey: 'item:one',
      summary: 'short',
    });

    // Announce only this shop's alert, then fail exactly its send.
    await announceNewAlerts(ports());
    mailer.failFor = email;
    await sendPendingEmail(ports());

    const rows = await harness.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.alertId, alert.alertId));

    const attempted = rows.find((row) => row.channel === 'email');
    expect(attempted?.failureReason).toBe('the relay refused the connection');
    // Still pending, because it has attempts left.
    expect(attempted?.status).toBe('pending');
    expect(attempted?.attempts).toBe(1);
  });
});
