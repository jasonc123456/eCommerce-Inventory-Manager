import {
  operatorAlerts,
  type AlertKind,
  type AlertSeverity,
  type Database,
  type OperatorAlert,
} from '@eim/db';
import { and, asc, desc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

/**
 * The life of an alert (section 22).
 *
 * Four states, and the distance between two of them is the whole design.
 *
 * *Acknowledged* is a person saying "I have seen this". *Resolved* is the world
 * saying "this has stopped being true". Milestone 4 treated them as one thing,
 * which meant a monitoring system could report that a problem had gone away
 * when what actually happened is that somebody clicked a button. Section 22
 * separates them: acknowledgement "suppresses ordinary repeats without hiding
 * ongoing state", and auto-resolution happens "only when a fresh check proves
 * recovery".
 *
 * So nothing in this module resolves an alert on a person's say-so.
 * `resolveAlert` demands evidence, and the database refuses a resolution
 * without it. What a person can do is acknowledge — which stops the reminders
 * and leaves the problem visible — or snooze, which stops them until a time
 * they chose and then lets the alert speak up again by itself.
 *
 * Deduplication is section 22's, on business, kind, subject, and state version.
 * A mapping blocked for six hours is one thing to deal with rather than seven
 * hundred, and an inbox with seven hundred copies of one sentence has not
 * informed anybody — it has hidden the alert that mattered behind the alert
 * that repeated.
 */

/** Escalation gaps, each measured from the previous notification. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Section 22: "reminders after fifteen minutes, one hour, and four hours, then
 * at most daily".
 *
 * Written as gaps rather than as offsets from the first notification, because a
 * gap needs only the previous notification's timestamp — which is a column —
 * where an offset would need the first one, which is a column nothing else
 * wants. Cumulatively these are the fifteen minutes, hour, and four hours
 * section 22 asks for.
 */
export const REMINDER_GAPS_MS: readonly number[] = [15 * MINUTE, 45 * MINUTE, 3 * HOUR];

/** After the schedule runs out, at most once a day until somebody deals with it. */
export const REPEAT_REMINDER_GAP_MS = 24 * HOUR;

/**
 * Only Error and Critical are reminded about.
 *
 * Section 22 names those two. An Info or Warning that repeated itself every
 * fifteen minutes would train people to ignore the channel that Critical also
 * arrives on, which is the expensive way to lose an oversell alert.
 */
export const REMINDABLE_SEVERITY_RANK = 3;

/** When the next reminder is due, given how many have already been sent. */
export function nextReminderAt(remindersSent: number, notifiedAt: Date): Date {
  const gap = REMINDER_GAPS_MS[remindersSent] ?? REPEAT_REMINDER_GAP_MS;
  return new Date(notifiedAt.getTime() + gap);
}

export interface RaiseAlertInput {
  /** Absent means the installation itself. Only installation kinds may omit it. */
  readonly businessId?: string;
  readonly kind: AlertKind;
  readonly severity?: AlertSeverity;
  /** What this is about. A repeat about the same subject finds the same row. */
  readonly subjectKey: string;
  /**
   * Section 22's fourth deduplication field. Set it when the same subject can
   * be wrong in a way that is genuinely a new problem — drift measured against
   * a newer desired version is not the drift somebody already looked at.
   */
  readonly stateVersion?: string;
  readonly summary: string;
  readonly recommendedAction?: string;
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
  /** False when this joined an alert that is still unresolved. */
  readonly isNew: boolean;
  /**
   * True when this occurrence made an already-notified alert more severe.
   *
   * Section 22: "material severity changes notify immediately." A warning that
   * has become critical is a different conversation, and waiting for the next
   * reminder to have it would be the wrong three hours to be quiet.
   */
  readonly severityEscalated: boolean;
}

export async function raiseAlert(db: Database, input: RaiseAlertInput): Promise<RaisedAlert> {
  const rows = await db.execute<{
    id: string;
    occurrences: number;
    is_new: boolean;
    severity_rank: number;
    notified_severity_rank: number | null;
    notified_at: Date | null;
  }>(sql`
    insert into operator_alerts (
      business_id, kind, severity, subject_key, state_version,
      summary, recommended_action, detail,
      mapping_id, canonical_item_id, connection_id, conflict_id, job_id
    )
    values (
      ${input.businessId ?? null}::uuid, ${input.kind}, ${input.severity ?? 'warning'},
      ${input.subjectKey}, ${input.stateVersion ?? ''},
      ${input.summary}, ${input.recommendedAction ?? null},
      ${JSON.stringify(input.detail ?? {})}::jsonb,
      ${input.mappingId ?? null}::uuid, ${input.canonicalItemId ?? null}::uuid,
      ${input.connectionId ?? null}::uuid, ${input.conflictId ?? null}::uuid,
      ${input.jobId ?? null}::uuid
    )
    on conflict (business_id, kind, subject_key, state_version)
      where resolved_at is null
      do update set
        occurrences  = operator_alerts.occurrences + 1,
        last_seen_at = now(),
        -- The newest wording wins. A blocked mapping whose reason changed from
        -- "rate limited" to "credentials rejected" is still one alert, and the
        -- reason a person reads should be the current one.
        summary      = excluded.summary,
        detail       = excluded.detail,
        recommended_action = excluded.recommended_action,
        -- Severity only ever rises while an alert is unresolved. Spelled out
        -- rather than a greatest() call, which on text compares lexically and
        -- would let 'warning' outrank 'critical'.
        severity = case
          when 'critical' in (operator_alerts.severity, excluded.severity) then 'critical'
          when 'error'    in (operator_alerts.severity, excluded.severity) then 'error'
          when 'warning'  in (operator_alerts.severity, excluded.severity) then 'warning'
          else 'info'
        end
    returning id, occurrences, (occurrences = 1) as is_new,
              severity_rank, notified_severity_rank, notified_at
  `);

  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error('raising an alert returned nothing');
  }

  // Decided here rather than inside the upsert because `severity_rank` is a
  // generated column: the merged value does not exist until the row has been
  // written, and re-deriving it inside the same statement would mean writing
  // the severity ordering a second time in a second place.
  const severityEscalated =
    row.notified_at !== null && row.severity_rank > (row.notified_severity_rank ?? 0);

  if (severityEscalated) {
    await db.execute(sql`
      update operator_alerts set next_reminder_at = now()
       where id = ${row.id}::uuid and resolved_at is null
    `);
  }

  return {
    alertId: row.id,
    occurrences: row.occurrences,
    isNew: row.is_new,
    severityEscalated,
  };
}

/**
 * "I have seen this."
 *
 * Stops the reminders and records who stopped them. It does not close the
 * alert, does not stop the occurrence count, and does not stop an escalation:
 * if the same problem gets worse, `raiseAlert` schedules an immediate
 * notification regardless of this.
 */
export async function acknowledgeAlert(
  db: Database,
  input: {
    readonly businessId?: string;
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
      nextReminderAt: null,
      ...(input.note === undefined ? {} : { acknowledgementNote: input.note }),
    })
    .where(
      and(
        scopedTo(input.businessId),
        eq(operatorAlerts.id, input.alertId),
        isNull(operatorAlerts.resolvedAt),
      ),
    )
    .returning({ id: operatorAlerts.id });

  return rows.length === 1;
}

/**
 * "Not now."
 *
 * Different from an acknowledgement in the one way that matters: it expires.
 * Nobody has to remember to un-snooze anything, and a problem that is still
 * there when the time passes goes back to being loud without a person having
 * to have been right about how long it would take.
 */
export async function snoozeAlert(
  db: Database,
  input: {
    readonly businessId?: string;
    readonly alertId: string;
    readonly actorUserId: string;
    readonly until: Date;
    readonly now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();

  // A snooze that has already expired is not a snooze, it is a no-op that looks
  // like one — the alert would be back before the screen finished reloading.
  if (input.until.getTime() <= now.getTime()) {
    return false;
  }

  const rows = await db
    .update(operatorAlerts)
    .set({ snoozedUntil: input.until, snoozedByUserId: input.actorUserId })
    .where(
      and(
        scopedTo(input.businessId),
        eq(operatorAlerts.id, input.alertId),
        isNull(operatorAlerts.resolvedAt),
      ),
    )
    .returning({ id: operatorAlerts.id });

  return rows.length === 1;
}

/**
 * A fresh check found the problem gone.
 *
 * The evidence is required, and the database enforces it. Section 22 permits
 * auto-resolution "only when a fresh check proves recovery", and a resolution
 * with nothing behind it is indistinguishable from a resolution somebody
 * guessed at — right up until the moment somebody needs to know which it was.
 */
export async function resolveAlert(
  db: Database,
  input: {
    readonly businessId?: string;
    readonly alertId: string;
    readonly evidence: Readonly<Record<string, unknown>>;
  },
): Promise<boolean> {
  const rows = await db
    .update(operatorAlerts)
    .set({
      resolvedAt: new Date(),
      resolvedEvidence: input.evidence,
      nextReminderAt: null,
    })
    .where(
      and(
        scopedTo(input.businessId),
        eq(operatorAlerts.id, input.alertId),
        isNull(operatorAlerts.resolvedAt),
      ),
    )
    .returning({ id: operatorAlerts.id });

  return rows.length === 1;
}

/**
 * Resolves whatever is outstanding about one subject.
 *
 * The shape a recovery check actually has: something rechecked a connection, a
 * mapping, a disk, and found it well. It does not need to know an alert
 * identifier, and requiring one would mean every check had to first go looking
 * for the complaint it was about to withdraw.
 *
 * Returns how many were resolved, which is zero on the ordinary healthy path.
 */
export async function resolveAlertsAbout(
  db: Database,
  input: {
    readonly businessId?: string;
    readonly kind: AlertKind;
    readonly subjectKey: string;
    readonly evidence: Readonly<Record<string, unknown>>;
  },
): Promise<number> {
  const rows = await db
    .update(operatorAlerts)
    .set({
      resolvedAt: new Date(),
      resolvedEvidence: input.evidence,
      nextReminderAt: null,
    })
    .where(
      and(
        scopedTo(input.businessId),
        eq(operatorAlerts.kind, input.kind),
        eq(operatorAlerts.subjectKey, input.subjectKey),
        isNull(operatorAlerts.resolvedAt),
      ),
    )
    .returning({ id: operatorAlerts.id });

  return rows.length;
}

/** What is currently outstanding for one business, worst first. */
export async function openAlerts(
  db: Database,
  businessId: string,
  limit = 100,
): Promise<OperatorAlert[]> {
  return db
    .select()
    .from(operatorAlerts)
    .where(and(eq(operatorAlerts.businessId, businessId), isNull(operatorAlerts.resolvedAt)))
    .orderBy(desc(operatorAlerts.severityRank), desc(operatorAlerts.lastSeenAt))
    .limit(limit);
}

/** What is currently outstanding for the installation itself, worst first. */
export async function openInstallationAlerts(db: Database, limit = 100): Promise<OperatorAlert[]> {
  return db
    .select()
    .from(operatorAlerts)
    .where(and(isNull(operatorAlerts.businessId), isNull(operatorAlerts.resolvedAt)))
    .orderBy(desc(operatorAlerts.severityRank), desc(operatorAlerts.lastSeenAt))
    .limit(limit);
}

/**
 * Everything a reminder is due for, across every scope.
 *
 * Snoozed alerts are excluded here rather than by clearing their schedule, so
 * that a snooze does not lose the escalation position it was standing at. When
 * the snooze lapses the alert is due immediately, which is what "not now"
 * meant.
 */
export async function alertsDueForReminder(
  db: Database,
  now: Date,
  limit = 200,
): Promise<OperatorAlert[]> {
  return db
    .select()
    .from(operatorAlerts)
    .where(
      and(
        isNull(operatorAlerts.resolvedAt),
        isNotNull(operatorAlerts.nextReminderAt),
        lte(operatorAlerts.nextReminderAt, now),
        or(isNull(operatorAlerts.snoozedUntil), lte(operatorAlerts.snoozedUntil, now)),
      ),
    )
    .orderBy(asc(operatorAlerts.nextReminderAt))
    .limit(limit);
}

/**
 * Records that somebody was told, and when to tell them again.
 *
 * One statement, because the counter and the next due time are the same fact
 * seen twice: a build that incremented one and failed before the other would
 * either remind forever or never remind again, and both look like a working
 * system from the outside.
 */
export async function recordNotified(db: Database, alertId: string, at: Date): Promise<void> {
  // How many reminders will have been sent once this notification is recorded.
  // The first notification is not a reminder, so it leaves the counter at zero.
  const remindersAfter = sql`(case when notified_at is null then 0 else reminders_sent + 1 end)`;

  // PostgreSQL arrays are one-based, so the gap for count N is element N + 1.
  const gaps = sql`array[${sql.join(
    REMINDER_GAPS_MS.map((gap) => sql`${gap}`),
    sql`, `,
  )}]::bigint[]`;

  await db.execute(sql`
    update operator_alerts set
      notified_at = ${at},
      notified_severity_rank = severity_rank,
      reminders_sent = ${remindersAfter},
      next_reminder_at = case
        when acknowledged_at is not null then null
        when severity_rank < ${REMINDABLE_SEVERITY_RANK} then null
        else ${at}::timestamptz + make_interval(secs =>
          coalesce((${gaps})[${remindersAfter} + 1], ${REPEAT_REMINDER_GAP_MS}) / 1000.0)
      end
    where id = ${alertId}::uuid and resolved_at is null
  `);
}

/**
 * Business scope, or the installation.
 *
 * A caller that passes no business is asking about installation alerts, not
 * about every business's alerts. Getting that backwards would be a
 * cross-business leak dressed as a convenience.
 */
function scopedTo(businessId: string | undefined) {
  return businessId === undefined
    ? isNull(operatorAlerts.businessId)
    : eq(operatorAlerts.businessId, businessId);
}
