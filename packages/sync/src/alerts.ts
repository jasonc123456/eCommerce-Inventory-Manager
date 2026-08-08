import { operatorAlerts, type AlertKind, type AlertSeverity, type Database } from '@eim/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

/**
 * Telling somebody (sections 11, 12, 22).
 *
 * Two rules shape this module, and both are about restraint rather than
 * coverage.
 *
 * An alert deduplicates on its subject. A mapping that has been blocked for six
 * hours is one thing to deal with, not seven hundred, and a system that sends
 * seven hundred messages has not informed anybody — it has made the real alerts
 * unfindable. The occurrence count and the last-seen time carry how persistent
 * a problem is without spending anybody's attention on repetition.
 *
 * An acknowledgement closes one alert, not a class of them. The next occurrence
 * opens a new row, so acknowledging "the store was down this morning" cannot
 * silence the same store going down again this afternoon. That asymmetry is
 * deliberate: the failure mode of alerting is not too few messages, it is a
 * dismissal that turns out to have been permanent.
 */

export interface RaiseAlertInput {
  readonly businessId: string;
  readonly kind: AlertKind;
  readonly severity?: AlertSeverity;
  /** What this is about. A repeat about the same subject finds the same row. */
  readonly subjectKey: string;
  readonly summary: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly mappingId?: string;
  readonly canonicalItemId?: string;
  readonly connectionId?: string;
  readonly conflictId?: string;
  readonly jobId?: string;
}

export interface RaisedAlert {
  readonly alertId: string;
  readonly occurrences: number;
  /** False when this joined an alert somebody has not yet dealt with. */
  readonly isNew: boolean;
}

export async function raiseAlert(db: Database, input: RaiseAlertInput): Promise<RaisedAlert> {
  const rows = await db.execute<{ id: string; occurrences: number; is_new: boolean }>(sql`
    insert into operator_alerts (
      business_id, kind, severity, subject_key, summary, detail,
      mapping_id, canonical_item_id, connection_id, conflict_id, job_id
    )
    values (
      ${input.businessId}::uuid, ${input.kind}, ${input.severity ?? 'warning'},
      ${input.subjectKey}, ${input.summary},
      ${JSON.stringify(input.detail ?? {})}::jsonb,
      ${input.mappingId ?? null}::uuid, ${input.canonicalItemId ?? null}::uuid,
      ${input.connectionId ?? null}::uuid, ${input.conflictId ?? null}::uuid,
      ${input.jobId ?? null}::uuid
    )
    on conflict (business_id, kind, subject_key) where acknowledged_at is null
      do update set
        occurrences  = operator_alerts.occurrences + 1,
        last_seen_at = now(),
        -- The newest wording wins. A blocked mapping whose reason changed from
        -- "rate limited" to "credentials rejected" is still one alert, and the
        -- reason a person reads should be the current one.
        summary      = excluded.summary,
        detail       = excluded.detail,
        -- Spelled out rather than a greatest() call, which on text compares
        -- lexically and would let 'warning' outrank 'critical'.
        severity = case
          when 'critical' in (operator_alerts.severity, excluded.severity) then 'critical'
          when 'warning'  in (operator_alerts.severity, excluded.severity) then 'warning'
          else 'info'
        end
    returning id, occurrences, (occurrences = 1) as is_new
  `);

  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error('raising an alert returned nothing');
  }

  return { alertId: row.id, occurrences: row.occurrences, isNew: row.is_new };
}

/** Closes one alert. The next occurrence opens a new one. */
export async function acknowledgeAlert(
  db: Database,
  input: {
    readonly businessId: string;
    readonly alertId: string;
    readonly actorUserId: string;
    readonly note?: string;
  },
): Promise<boolean> {
  const rows = await db
    .update(operatorAlerts)
    .set({
      acknowledgedAt: new Date(),
      acknowledgedByUserId: input.actorUserId,
      ...(input.note === undefined ? {} : { acknowledgementNote: input.note }),
    })
    .where(
      and(
        eq(operatorAlerts.businessId, input.businessId),
        eq(operatorAlerts.id, input.alertId),
        isNull(operatorAlerts.acknowledgedAt),
      ),
    )
    .returning({ id: operatorAlerts.id });

  return rows.length === 1;
}

/** What is currently outstanding, worst first. */
export async function openAlerts(db: Database, businessId: string, limit = 100) {
  return db
    .select()
    .from(operatorAlerts)
    .where(and(eq(operatorAlerts.businessId, businessId), isNull(operatorAlerts.acknowledgedAt)))
    .orderBy(desc(operatorAlerts.severity), desc(operatorAlerts.lastSeenAt))
    .limit(limit);
}

/**
 * Section 11's oversell alert.
 *
 * Critical, and keyed by the item rather than by the order. Ten customers who
 * all bought the last one are one shortage to resolve; ten alerts would be ten
 * copies of the same sentence, and the eleventh customer's would be the one
 * nobody read.
 */
export async function alertOversold(
  db: Database,
  input: {
    readonly businessId: string;
    readonly canonicalItemId: string;
    readonly externalOrderId: string;
    readonly shortage: number;
  },
): Promise<RaisedAlert> {
  return raiseAlert(db, {
    businessId: input.businessId,
    kind: 'oversold',
    severity: 'critical',
    subjectKey: `item:${input.canonicalItemId}`,
    canonicalItemId: input.canonicalItemId,
    summary: `an order could not be filled in full: ${String(input.shortage)} units short`,
    detail: { externalOrderId: input.externalOrderId, shortage: input.shortage },
  });
}

/** A mapping that has stopped synchronizing and will not resume by itself. */
export async function alertMappingBlocked(
  db: Database,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly reason: string;
  },
): Promise<RaisedAlert> {
  return raiseAlert(db, {
    businessId: input.businessId,
    kind: 'mapping_blocked',
    severity: 'critical',
    subjectKey: `mapping:${input.mappingId}`,
    mappingId: input.mappingId,
    summary: `this channel mapping has stopped synchronizing: ${input.reason}`,
    detail: { reason: input.reason },
  });
}

/**
 * A job that gave up.
 *
 * Keyed by the job rather than by its kind: a dead-lettered job is a specific
 * piece of work that specific stock is waiting on, and section 12 lets an
 * operator replay it once the cause has passed. Collapsing them by kind would
 * leave no way to find the one that mattered.
 */
export async function alertJobDeadLettered(
  db: Database,
  input: {
    readonly businessId: string;
    readonly jobId: string;
    readonly kind: string;
    readonly reason: string;
  },
): Promise<RaisedAlert> {
  return raiseAlert(db, {
    businessId: input.businessId,
    kind: 'job_dead_lettered',
    severity: 'warning',
    subjectKey: `job:${input.jobId}`,
    jobId: input.jobId,
    summary: `${input.kind} gave up after repeated failures: ${input.reason}`,
    detail: { jobKind: input.kind, reason: input.reason },
  });
}

/** An unexplained disagreement waiting for somebody to decide. */
export async function alertConflict(
  db: Database,
  input: {
    readonly businessId: string;
    readonly conflictId: string;
    readonly mappingId?: string;
    readonly summary: string;
  },
): Promise<RaisedAlert> {
  return raiseAlert(db, {
    businessId: input.businessId,
    kind: 'reconciliation_conflict',
    severity: 'critical',
    subjectKey: `conflict:${input.conflictId}`,
    conflictId: input.conflictId,
    ...(input.mappingId === undefined ? {} : { mappingId: input.mappingId }),
    summary: input.summary,
  });
}
