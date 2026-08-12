import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { backgroundJobs } from './jobs';
import { inventoryConflicts } from './reconciliation';
import { businesses, users } from './tenancy';

/**
 * Typed access to operator alerts (sections 11, 12, 22).
 *
 * `migrations/0020_alerts.sql` and `0025_alert_lifecycle.sql` are the source of
 * truth. Three parts of them are not expressible here and are the parts that
 * matter: the partial unique index that keeps one *unresolved* alert per
 * subject, the check that ties installation kinds to a null business, and the
 * check that a resolution must carry the evidence that proved it.
 */

/**
 * Kinds that belong to one shop.
 *
 * Section 22's "immediately alert business owners and appropriately permitted
 * users" list, plus the four milestone 4 already raised.
 */
export const businessAlertKinds = [
  'oversold',
  'mapping_blocked',
  'job_dead_lettered',
  'connection_unhealthy',
  'restock_pending',
  'reconciliation_conflict',
  'channel_stockout',
  'unsafe_drift',
  'credential_revoked',
  'sync_failing',
  'quota_exhausted',
] as const;
export type BusinessAlertKind = (typeof businessAlertKinds)[number];

/**
 * Kinds that belong to nobody's shop.
 *
 * Section 22's "immediately alert installation administrators" list. These
 * carry no `businessId`, because the queue is not any one shop's queue and
 * filing a stalled worker under whichever business happened to be first would
 * delete the alert along with that business.
 */
export const installationAlertKinds = [
  'worker_unavailable',
  'scheduler_unavailable',
  'queue_stalled',
  'smtp_failing',
  'database_unready',
  'backup_failed',
  'migration_mismatch',
  'disk_pressure',
  'configuration_invalid',
] as const;
export type InstallationAlertKind = (typeof installationAlertKinds)[number];

export const alertKinds = [...businessAlertKinds, ...installationAlertKinds] as const;
export type AlertKind = (typeof alertKinds)[number];

export function isInstallationAlertKind(kind: AlertKind): kind is InstallationAlertKind {
  return (installationAlertKinds as readonly string[]).includes(kind);
}

/** Section 22's four severities, weakest first. The order is load-bearing. */
export const alertSeverities = ['info', 'warning', 'error', 'critical'] as const;
export type AlertSeverity = (typeof alertSeverities)[number];

/**
 * The same ranking the database generates, for code that has a severity in hand
 * rather than a row. Kept beside the column it mirrors so the two are read
 * together; `alerts.test.ts` asserts they agree.
 */
export const ALERT_SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/** Section 22's four states. Derived from timestamps, never stored. */
export const alertStates = ['open', 'acknowledged', 'snoozed', 'resolved'] as const;
export type AlertState = (typeof alertStates)[number];

export const alertScopes = ['business', 'installation'] as const;
export type AlertScope = (typeof alertScopes)[number];

export const operatorAlerts = pgTable(
  'operator_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null means the installation itself. See `installationAlertKinds`. */
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    /** Generated from `businessId`, so it cannot disagree with it. */
    scope: text('scope', { enum: alertScopes })
      .notNull()
      .generatedAlwaysAs(
        sql`(case when business_id is null then 'installation' else 'business' end)`,
      ),
    kind: text('kind', { enum: alertKinds }).notNull(),
    severity: text('severity', { enum: alertSeverities }).notNull().default('warning'),
    /** Generated. Ordering by the name would sort critical between a and e. */
    severityRank: smallint('severity_rank')
      .notNull()
      .generatedAlwaysAs(
        sql`(case severity when 'critical' then 4 when 'error' then 3 when 'warning' then 2 else 1 end)`,
      ),
    subjectKey: text('subject_key').notNull(),
    /** The fourth part of section 22's deduplication key. Empty, not null. */
    stateVersion: text('state_version').notNull().default(''),
    summary: text('summary').notNull(),
    detail: jsonb('detail').notNull().default({}),
    recommendedAction: text('recommended_action'),
    mappingId: uuid('mapping_id'),
    canonicalItemId: uuid('canonical_item_id'),
    connectionId: uuid('connection_id'),
    conflictId: uuid('conflict_id').references(() => inventoryConflicts.id, {
      onDelete: 'set null',
    }),
    jobId: uuid('job_id').references(() => backgroundJobs.id, { onDelete: 'set null' }),
    occurrences: integer('occurrences').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedByUserId: uuid('acknowledged_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    acknowledgementNote: text('acknowledgement_note'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    snoozedByUserId: uuid('snoozed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Set only by a check that ran later and found the problem gone. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedEvidence: jsonb('resolved_evidence'),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    notifiedSeverityRank: smallint('notified_severity_rank'),
    remindersSent: integer('reminders_sent').notNull().default(0),
    nextReminderAt: timestamp('next_reminder_at', { withTimezone: true }),
  },
  (table) => [
    index('operator_alerts_unresolved').on(table.businessId, table.severityRank, table.lastSeenAt),
  ],
);

export type OperatorAlert = typeof operatorAlerts.$inferSelect;

/**
 * What state an alert is in, at a given moment.
 *
 * Computed rather than read, because one of the four transitions happens
 * without anybody writing a row: a snooze ends when the clock passes it. A
 * stored column would be wrong for as long as it took some sweep to notice,
 * and the window in which it is wrong is exactly the window in which somebody
 * is looking at a list wondering why nothing has come back.
 *
 * Order matters. Resolved wins over everything — a problem that has been proven
 * gone is not still snoozed. A live snooze wins over an acknowledgement,
 * because it is the more recent and more specific instruction.
 */
export function alertStateAt(
  alert: Pick<OperatorAlert, 'resolvedAt' | 'snoozedUntil' | 'acknowledgedAt'>,
  now: Date,
): AlertState {
  if (alert.resolvedAt !== null) {
    return 'resolved';
  }

  if (alert.snoozedUntil !== null && alert.snoozedUntil.getTime() > now.getTime()) {
    return 'snoozed';
  }

  return alert.acknowledgedAt === null ? 'open' : 'acknowledged';
}
