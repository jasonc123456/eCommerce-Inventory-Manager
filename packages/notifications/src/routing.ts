import type { BusinessPermission, InstallationPermission } from '@eim/authz';
import {
  ALERT_SEVERITY_RANK,
  type AlertKind,
  type AlertSeverity,
  type BusinessAlertKind,
  type EmailSeverityFloor,
  type InstallationAlertKind,
} from '@eim/db';

import { quietUntil, type QuietHours } from './quiet-hours';

/**
 * Who hears about an alert, on what channel, and when (sections 5, 11, 22).
 *
 * Everything here is a pure decision over facts somebody else read from the
 * database. That is not tidiness: routing is the part of notification that is
 * easiest to get quietly wrong — an off-by-one in a permission check sends a
 * shop's stock levels to somebody who was denied them, and a mishandled quiet
 * window swallows an oversell until morning. Both are testable only if the
 * decision does not need a database, a clock, or a mailer to reach.
 *
 * Three rules, in order, and the order matters.
 *
 * Permission first. Section 22 routes "by granular permission", so a preference
 * can never widen what somebody may see. Preference only ever narrows.
 *
 * Then preference, which chooses the channel rather than the audience. Somebody
 * who has switched email off still sees the alert in the application; section 22
 * is explicit that acknowledgement and delivery do not hide ongoing state.
 *
 * Then quiet hours, which choose the moment. Critical inventory-safety alerts
 * ignore them, and nothing else does.
 */

/**
 * Which permission a kind is addressed to.
 *
 * The mapping is the audience: an alert with no permission behind it is one
 * that either goes to everybody or to nobody, and both of those are how a
 * notification system stops being read.
 *
 * Business owners hold every business permission, so section 11's "notify all
 * owners and users with `receive_critical_inventory_alerts`" falls out of the
 * table rather than needing a special case.
 */
export const BUSINESS_ALERT_PERMISSION: Readonly<Record<BusinessAlertKind, BusinessPermission>> = {
  oversold: 'receive_critical_inventory_alerts',
  channel_stockout: 'receive_critical_inventory_alerts',
  unsafe_drift: 'receive_critical_inventory_alerts',
  restock_pending: 'confirm_restock',
  mapping_blocked: 'view_mappings',
  reconciliation_conflict: 'resolve_inventory_conflicts',
  job_dead_lettered: 'view_sync_activity',
  sync_failing: 'view_sync_activity',
  connection_unhealthy: 'view_connection_health',
  credential_revoked: 'manage_integrations',
  quota_exhausted: 'view_connection_health',
};

/** Installation alerts go to installation administrators, never to a business. */
export const INSTALLATION_ALERT_PERMISSION: Readonly<
  Record<InstallationAlertKind, InstallationPermission>
> = {
  worker_unavailable: 'view_system_health',
  scheduler_unavailable: 'view_system_health',
  queue_stalled: 'view_system_health',
  smtp_failing: 'view_system_health',
  database_unready: 'view_system_health',
  disk_pressure: 'view_system_health',
  configuration_invalid: 'manage_installation_settings',
  migration_mismatch: 'view_update_status',
  backup_failed: 'view_backup_status',
};

/**
 * The kinds that wake somebody up.
 *
 * Section 22: "Critical inventory safety alerts bypass quiet hours; ordinary
 * reminders/digests do not." Safety here means the shop may be selling stock it
 * does not have — an oversell, or a channel that has drifted away from the
 * ledger — because those keep costing money and goodwill for every hour nobody
 * knows. A stockout is a lost sale, which is bad and can wait until the shop
 * opens; putting it on this list would be the beginning of everything being on
 * this list.
 */
export const INVENTORY_SAFETY_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>([
  'oversold',
  'unsafe_drift',
]);

/** Whether this particular alert is allowed to interrupt a quiet period. */
export function bypassesQuietHours(kind: AlertKind, severity: AlertSeverity): boolean {
  return severity === 'critical' && INVENTORY_SAFETY_KINDS.has(kind);
}

/** One candidate recipient, as read from membership and preferences. */
export interface Recipient {
  readonly userId: string;
  readonly email: string;
  /** What this person may see in this business. Owners hold everything. */
  readonly permissions: ReadonlySet<string>;
  /** Absent when they have never opened the settings screen. */
  readonly preference?: {
    readonly emailMinSeverity: EmailSeverityFloor;
    readonly emailOptedInKinds: readonly string[];
    readonly emailMutedKinds: readonly string[];
  };
}

export interface RoutableAlert {
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
}

export type NotificationChannel = 'in_app' | 'email';

export interface Delivery {
  readonly userId: string;
  readonly email: string;
  readonly channels: readonly NotificationChannel[];
  /**
   * Null means send now. A time means the shop is in its quiet hours and this
   * alert is not one of the two that may interrupt them.
   */
  readonly deferUntil: Date | null;
}

export interface RoutingInput {
  readonly alert: RoutableAlert;
  readonly recipients: readonly Recipient[];
  readonly quietHours?: QuietHours;
  readonly now: Date;
}

/**
 * Who to tell, how, and when.
 *
 * Returns one entry per permitted recipient. Somebody permitted always appears,
 * even with email switched off — the in-app channel is not optional, because an
 * alert nobody can find in the application is an alert that only exists in a
 * mailbox somebody may have deleted.
 */
export function routeAlert(input: RoutingInput): readonly Delivery[] {
  const required = permissionFor(input.alert.kind);
  const quietHours = input.quietHours;

  // `quietUntil` answers null outside the window, so asking it is also the test
  // for whether the shop is in one. Two ways to ask the same question is how
  // one of them ends up disagreeing with the other.
  const deferUntil =
    quietHours === undefined || bypassesQuietHours(input.alert.kind, input.alert.severity)
      ? null
      : quietUntil(input.now, quietHours);

  const deliveries: Delivery[] = [];

  for (const recipient of input.recipients) {
    if (!recipient.permissions.has(required)) {
      continue;
    }

    const channels: NotificationChannel[] = ['in_app'];
    if (wantsEmail(input.alert, recipient)) {
      channels.push('email');
    }

    deliveries.push({
      userId: recipient.userId,
      email: recipient.email,
      channels,
      // The in-app entry is never deferred — it is a row somebody may already
      // be looking at. Only the email waits, and a delivery with no email to
      // send has nothing to wait for.
      deferUntil: channels.includes('email') ? deferUntil : null,
    });
  }

  return deliveries;
}

/** The permission an alert of this kind is addressed to. */
export function permissionFor(kind: AlertKind): string {
  return (
    (BUSINESS_ALERT_PERMISSION as Record<string, string>)[kind] ??
    (INSTALLATION_ALERT_PERMISSION as Record<string, string>)[kind] ??
    // Unreachable while every kind is in one of the two tables, which
    // `routing.test.ts` asserts. Denying is the safe answer if it ever is not.
    'manage_installation_settings'
  );
}

/**
 * Whether this person asked to be emailed about this.
 *
 * A mute never applies to Critical. Section 22 lets people choose what reaches
 * their inbox, and a preference that could suppress an oversell is one that
 * eventually does, on the day it matters, for somebody who set it months
 * earlier for an unrelated reason.
 */
function wantsEmail(alert: RoutableAlert, recipient: Recipient): boolean {
  const preference = recipient.preference;

  if (preference === undefined) {
    // Section 22's default: Error and above. A new owner who has never opened
    // the settings screen still hears about an oversell.
    return ALERT_SEVERITY_RANK[alert.severity] >= ALERT_SEVERITY_RANK.error;
  }

  if (alert.severity === 'critical') {
    return preference.emailMinSeverity !== 'none';
  }

  if (preference.emailMutedKinds.includes(alert.kind)) {
    return false;
  }

  if (preference.emailOptedInKinds.includes(alert.kind)) {
    return preference.emailMinSeverity !== 'none';
  }

  if (preference.emailMinSeverity === 'none') {
    return false;
  }

  return ALERT_SEVERITY_RANK[alert.severity] >= ALERT_SEVERITY_RANK[preference.emailMinSeverity];
}
