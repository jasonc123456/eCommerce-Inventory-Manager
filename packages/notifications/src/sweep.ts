import {
  alertStateAt,
  operatorAlerts,
  type Database,
  type NotificationDelivery,
  type OperatorAlert,
} from '@eim/db';
import { renderAlertNotice, type Mailer } from '@eim/mail';
import { and, asc, isNull, sql } from 'drizzle-orm';

import { alertsDueForReminder, recordNotified } from './alerts';
import {
  claimDueDeliveries,
  markDelivered,
  markFailed,
  recordDeliveries,
  recordSuppressed,
} from './dispatch';
import { loadPreferences, loadQuietHours } from './preferences';
import { listRecipients } from './recipients';
import { routeAlert, type Recipient } from './routing';

/**
 * The loop that actually tells somebody (section 22).
 *
 * Four passes, kept separate on purpose.
 *
 * *Announce* takes alerts nobody has been told about yet. *Remind* takes alerts
 * whose reminder has come due. Both end at a written intent and neither sends
 * anything. *Send* takes written intents and puts them on a wire. Splitting the
 * decision from the transmission is what makes a stuck mail relay a queue of
 * pending rows rather than a reason alerts stop being raised.
 *
 * Every pass is safe to run twice. That is not politeness toward the scheduler:
 * a sweep is exactly the kind of process that dies halfway, and the recovery
 * story for one that is not idempotent is a person deciding whether to risk
 * sending everything again.
 */

export interface SweepPorts {
  readonly db: Database;
  /** Absent when the installation has no SMTP configured. Email is then skipped. */
  readonly mailer: Mailer | null;
  readonly productName: string;
  readonly publicUrl: string;
  readonly now?: () => Date;
}

export interface SweepResult {
  readonly considered: number;
  readonly announced: number;
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
}

const EMPTY: SweepResult = {
  considered: 0,
  announced: 0,
  sent: 0,
  failed: 0,
  suppressed: 0,
};

/**
 * Alerts nobody has been told about.
 *
 * Ordered oldest first so that a backlog drains in the order things went wrong,
 * which is the order somebody would want to read them in. Bounded, because a
 * sweep that tried to announce ten thousand alerts in one pass would hold its
 * database connection for the length of ten thousand sends.
 */
export async function announceNewAlerts(ports: SweepPorts, limit = 100): Promise<SweepResult> {
  const now = ports.now?.() ?? new Date();

  const pending = await ports.db
    .select()
    .from(operatorAlerts)
    .where(and(isNull(operatorAlerts.resolvedAt), isNull(operatorAlerts.notifiedAt)))
    .orderBy(asc(operatorAlerts.firstSeenAt))
    .limit(limit);

  return notifyEach(ports, pending, now);
}

/** Alerts whose next reminder has come due. */
export async function sendDueReminders(ports: SweepPorts, limit = 100): Promise<SweepResult> {
  const now = ports.now?.() ?? new Date();
  const due = await alertsDueForReminder(ports.db, now, limit);

  return notifyEach(ports, due, now);
}

async function notifyEach(
  ports: SweepPorts,
  alerts: readonly OperatorAlert[],
  now: Date,
): Promise<SweepResult> {
  let announced = 0;
  let suppressed = 0;

  // Preferences and quiet hours are per business and every alert in a batch is
  // likely to share one, so they are read once each rather than per alert.
  const preferenceCache = new Map<string, readonly Recipient[]>();

  for (const alert of alerts) {
    const state = alertStateAt(alert, now);
    const recipients = await recipientsFor(ports, alert, preferenceCache);
    const quietHours =
      alert.businessId === null ? undefined : await loadQuietHours(ports.db, alert.businessId);

    const deliveries = routeAlert({
      alert: { kind: alert.kind, severity: alert.severity },
      recipients,
      ...(quietHours === undefined ? {} : { quietHours }),
      now,
    });

    // Which notification about this alert this is, counted the same way
    // `recordNotified` counts it. The first is zero; each reminder is one more.
    //
    // It has to be computed here rather than read off the row, because the row
    // still holds the previous count: using it would give the fifteen-minute
    // reminder the same idempotency key as the first notification, and the
    // unique index would silently swallow it. A reminder that is deduplicated
    // against the message it is reminding you about is a reminder that never
    // arrives.
    const notificationNumber = alert.notifiedAt === null ? 0 : alert.remindersSent + 1;

    const written = {
      ...(alert.businessId === null ? {} : { businessId: alert.businessId }),
      alertId: alert.id,
      remindersSent: notificationNumber,
      deliveries,
    };

    // An acknowledged or snoozed alert has already had somebody say they are
    // dealing with it. Section 22 suppresses the ordinary repeats — and the
    // suppression is written against the same recipients the message would have
    // gone to, because "nobody was told, and here is who that was" is the
    // answer somebody needs after an incident.
    if (state === 'acknowledged' || state === 'snoozed') {
      await recordSuppressed(ports.db, {
        ...written,
        reason: `the alert was ${state} when the notification came due`,
      });
      suppressed += 1;
    } else {
      await recordDeliveries(ports.db, written);
      announced += 1;
    }

    // Recorded either way, and even when nobody was permitted to hear it.
    // Otherwise an alert with no audience is re-announced on every pass
    // forever, and the sweep spends its whole budget on the one thing it can do
    // nothing about.
    await recordNotified(ports.db, alert.id, now);
  }

  return { ...EMPTY, considered: alerts.length, announced, suppressed };
}

/**
 * Who to consider for one alert.
 *
 * Installation alerts have no membership to read, and this returns nobody for
 * them rather than guessing. They are surfaced on the system-health screen,
 * which is where an installation administrator is already looking; wiring them
 * to a business's members would be a cross-tenant leak dressed as helpfulness.
 */
async function recipientsFor(
  ports: SweepPorts,
  alert: OperatorAlert,
  cache: Map<string, readonly Recipient[]>,
): Promise<readonly Recipient[]> {
  if (alert.businessId === null) {
    return [];
  }

  const cached = cache.get(alert.businessId);
  if (cached !== undefined) {
    return cached;
  }

  const members = await listRecipients(ports.db, alert.businessId);
  const preferences = await loadPreferences(ports.db, alert.businessId);

  const withPreferences = members.map((member) => {
    const preference = preferences.get(member.userId);

    return preference === undefined
      ? member
      : {
          ...member,
          preference: {
            emailMinSeverity: preference.emailMinSeverity,
            emailOptedInKinds: preference.emailOptedInKinds,
            emailMutedKinds: preference.emailMutedKinds,
          },
        };
  });

  cache.set(alert.businessId, withPreferences);
  return withPreferences;
}

/**
 * Puts the written intents on a wire.
 *
 * An installation with no SMTP configured skips the pass entirely rather than
 * failing every message five times: there is nothing wrong with the alerts, and
 * marking them failed would bury the real problem, which is that nobody has
 * configured a relay.
 */
export async function sendPendingEmail(ports: SweepPorts, limit = 50): Promise<SweepResult> {
  const now = ports.now?.() ?? new Date();
  const mailer = ports.mailer;

  if (mailer === null) {
    return EMPTY;
  }

  const claimed = await claimDueDeliveries(ports.db, 'email', now, limit);
  let sent = 0;
  let failed = 0;

  for (const delivery of claimed) {
    const message = await composeAlertEmail(ports, delivery);

    if (message === null) {
      // The alert or the recipient is gone. Nothing to send, and nothing wrong.
      await markFailed(ports.db, delivery.id, 'the alert or recipient no longer exists');
      failed += 1;
      continue;
    }

    const outcome = await mailer.send(message);

    if (outcome.delivered) {
      await markDelivered(ports.db, delivery.id, now);
      sent += 1;
    } else {
      // The mailer's own describable failure, not the driver's error text,
      // which routinely quotes the envelope and sometimes the body back.
      await markFailed(ports.db, delivery.id, outcome.failure.summary);
      failed += 1;
    }
  }

  return { ...EMPTY, considered: claimed.length, sent, failed };
}

async function composeAlertEmail(
  ports: SweepPorts,
  delivery: NotificationDelivery,
): Promise<{ to: string; subject: string; text: string; html: string } | null> {
  const rows = await ports.db.execute<{
    kind: string;
    severity: string;
    summary: string;
    recommended_action: string | null;
    occurrences: number;
    // Raw SQL, so these arrive as the driver renders them rather than as the
    // mapped types the query builder would produce.
    first_seen_at: string | Date;
    last_seen_at: string | Date;
    business_name: string | null;
    email: string | null;
  }>(sql`
    select a.kind, a.severity, a.summary, a.recommended_action, a.occurrences,
           a.first_seen_at, a.last_seen_at, b.name as business_name, u.email
      from operator_alerts a
      left join businesses b on b.id = a.business_id
      left join users u on u.id = ${delivery.recipientUserId}::uuid
     where a.id = ${delivery.alertId}::uuid
     limit 1
  `);

  const row = rows.rows[0];

  // Either the alert or the person it was addressed to has been deleted since
  // the intent was written. Nothing to send, and nothing wrong.
  if (row?.email == null) {
    return null;
  }

  const rendered = renderAlertNotice({
    productName: ports.productName,
    publicUrl: ports.publicUrl,
    ...(row.business_name === null ? {} : { businessName: row.business_name }),
    severity: row.severity.charAt(0).toUpperCase() + row.severity.slice(1),
    summary: row.summary,
    ...(row.recommended_action === null ? {} : { recommendedAction: row.recommended_action }),
    occurrences: row.occurrences,
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    path: '/alerts',
  });

  return { to: row.email, ...rendered };
}
