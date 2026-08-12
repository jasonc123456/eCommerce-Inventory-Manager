import { authorize, type BusinessPermission, type Subject } from '@eim/authz';
import {
  alertStateAt,
  businesses,
  type AlertKind,
  type AlertState,
  type NotificationDelivery,
  type OperatorAlert,
  type UserNotificationPreference,
} from '@eim/db';
import {
  deliveriesFor,
  loadBusinessSettings,
  loadPreference,
  openAlerts,
  BUSINESS_ALERT_PERMISSION,
} from '@eim/notifications';
import { eq } from 'drizzle-orm';

import { identity } from './identity';
import { runtime } from './runtime';

/**
 * The alerts screen, wired for the web tier (section 22).
 *
 * What a person sees here is scoped by the same permission table that decided
 * whether to email them — imported rather than restated, because two lists
 * would be two answers to one question, and the divergence would show up as
 * somebody emailed about a problem they cannot open.
 *
 * "May see it on a screen" and "may be told about it" really are the same
 * question. An alert is about stock, connections, or money, and an application
 * that answered them differently would be one where reading your inbox told you
 * more than signing in.
 */

/** The routing table, narrowed to the lookup this file performs. */
const PERMISSION_FOR: Readonly<Partial<Record<AlertKind, BusinessPermission>>> =
  BUSINESS_ALERT_PERMISSION;

export interface AlertRow {
  readonly alert: OperatorAlert;
  readonly state: AlertState;
  /** What was sent about it, most recent first. Empty until a sweep has run. */
  readonly deliveries: readonly NotificationDelivery[];
}

export interface AlertsView {
  readonly outstanding: readonly AlertRow[];
  readonly preference: UserNotificationPreference | null;
  readonly quietHours: { readonly start: string; readonly end: string } | null;
  readonly mayManageNotifications: boolean;
  /** The shop's own zone, so a wall clock on screen reads as the router reads it. */
  readonly timezone: string;
}

const EMPTY: AlertsView = {
  outstanding: [],
  preference: null,
  quietHours: null,
  mayManageNotifications: false,
  timezone: 'UTC',
};

/**
 * Everything the alerts screen shows.
 *
 * The delivery history is loaded with each alert rather than behind a click,
 * because the question people ask about an alert is almost always "did anybody
 * actually get told" — and answering it one click away means answering it after
 * somebody has already assumed.
 */
export async function loadAlerts(businessId: string, userId: string): Promise<AlertsView> {
  const { db } = runtime();
  const subject = await identity().memberships.loadSubject(db, businessId, userId);

  if (subject === null) {
    return EMPTY;
  }

  const now = new Date();
  const permitted = (await openAlerts(db, businessId)).filter((alert) => maySee(subject, alert));

  const outstanding = await Promise.all(
    permitted.map(async (alert) => ({
      alert,
      state: alertStateAt(alert, now),
      deliveries: await deliveriesFor(db, alert.id, 10),
    })),
  );

  const settings = await loadBusinessSettings(db, businessId);
  const shop = await db
    .select({ timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);

  return {
    outstanding,
    preference: await loadPreference(db, businessId, userId),
    quietHours:
      settings?.quietHoursStart == null || settings.quietHoursEnd === null
        ? null
        : { start: settings.quietHoursStart, end: settings.quietHoursEnd },
    mayManageNotifications: authorize(subject, 'manage_notifications').allowed,
    timezone: shop[0]?.timezone ?? 'UTC',
  };
}

/** Whether this subject may see this alert at all. */
export function maySee(subject: Subject, alert: Pick<OperatorAlert, 'kind'>): boolean {
  const permission = PERMISSION_FOR[alert.kind];

  // An installation alert has no business permission and never appears on a
  // business screen. Denying is also the right answer for a kind added to the
  // schema before it was added to the routing table.
  return permission !== undefined && authorize(subject, permission).allowed;
}
