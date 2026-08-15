import {
  businessRetentionSettings,
  isRawDataClass,
  retentionDataClasses,
  retentionRuns,
  type BusinessRetentionSettings,
  type Database,
  type RetentionDataClass,
} from '@eim/db';
import { eq, sql } from 'drizzle-orm';

/**
 * Deleting what is past keeping (sections 13, 22, 37).
 *
 * Three decisions shape this.
 *
 * A sweep deletes in bounded batches and says how many it took. Unbounded
 * deletes on a table with a year of history are a long transaction holding
 * locks against the same rows the application is writing, and the first time
 * anybody discovers that is on the installation with the most data.
 *
 * "Zero means keep" applies to history and never to raw bodies. Section 37
 * allows unlimited retention "only where law, erasure, security, and disk
 * policy permit", and a raw webhook body holds buyer data section 13 obliges
 * this application to be able to erase. The schema refuses zero there; this
 * refuses to interpret it.
 *
 * What is recorded is a count, not a list. A list of what was deleted would
 * make the retention log the longest-lived copy of the data the sweep exists to
 * remove, which is the exact failure the whole feature is meant to prevent.
 */

/** How many rows one pass removes per class. Small enough not to hold locks. */
export const RETENTION_BATCH = 5_000;

export const DEFAULT_HISTORY_DAYS = 180;
export const DEFAULT_RAW_EVENT_DAYS = 30;

export interface RetentionPolicy {
  readonly historyDays: number;
  readonly rawEventDays: number;
}

export const DEFAULT_POLICY: RetentionPolicy = {
  historyDays: DEFAULT_HISTORY_DAYS,
  rawEventDays: DEFAULT_RAW_EVENT_DAYS,
};

/** The settings for a business, or the defaults it has never changed. */
export function policyOf(settings: BusinessRetentionSettings | null): RetentionPolicy {
  return settings === null
    ? DEFAULT_POLICY
    : { historyDays: settings.historyDays, rawEventDays: settings.rawEventDays };
}

/**
 * The cutoff for one class, or null when nothing should be deleted.
 *
 * Null rather than a date far in the past, so that "keep everything" is a
 * distinct answer a caller has to handle rather than a very old cutoff that
 * happens to match nothing today and might match something in a decade.
 */
export function cutoffFor(
  dataClass: RetentionDataClass,
  policy: RetentionPolicy,
  now: Date,
): Date | null {
  const days = isRawDataClass(dataClass) ? policy.rawEventDays : policy.historyDays;

  // Zero is "keep", and only history may say it. A raw class that somehow
  // arrived here with zero is treated as its default rather than as permission
  // to keep buyer data indefinitely.
  if (days <= 0) {
    return isRawDataClass(dataClass)
      ? new Date(now.getTime() - DEFAULT_RAW_EVENT_DAYS * 86_400_000)
      : null;
  }

  return new Date(now.getTime() - days * 86_400_000);
}

export interface SweepOutcome {
  readonly dataClass: RetentionDataClass;
  readonly rowsDeleted: number;
  readonly olderThan: Date | null;
}

export async function loadRetentionSettings(
  db: Database,
  businessId: string,
): Promise<BusinessRetentionSettings | null> {
  const rows = await db
    .select()
    .from(businessRetentionSettings)
    .where(eq(businessRetentionSettings.businessId, businessId))
    .limit(1);

  return rows[0] ?? null;
}

export async function saveRetentionSettings(
  db: Database,
  businessId: string,
  input: { readonly historyDays?: number; readonly rawEventDays?: number },
): Promise<void> {
  const values = {
    ...(input.historyDays === undefined ? {} : { historyDays: input.historyDays }),
    ...(input.rawEventDays === undefined ? {} : { rawEventDays: input.rawEventDays }),
  };

  await db
    .insert(businessRetentionSettings)
    .values({ businessId, ...values })
    .onConflictDoUpdate({
      target: businessRetentionSettings.businessId,
      set: { ...values, updatedAt: new Date() },
    });
}

/**
 * One pass over one business.
 *
 * Returns what each class did, including the classes that did nothing, so a
 * caller can tell "nothing was old enough" from "this class was skipped".
 */
export async function sweepBusiness(
  db: Database,
  businessId: string,
  now = new Date(),
): Promise<readonly SweepOutcome[]> {
  const policy = policyOf(await loadRetentionSettings(db, businessId));
  const outcomes: SweepOutcome[] = [];

  for (const dataClass of retentionDataClasses) {
    const olderThan = cutoffFor(dataClass, policy, now);

    if (olderThan === null) {
      outcomes.push({ dataClass, rowsDeleted: 0, olderThan: null });
      continue;
    }

    const rowsDeleted = await deleteBatch(db, dataClass, businessId, olderThan);
    outcomes.push({ dataClass, rowsDeleted, olderThan });

    if (rowsDeleted > 0) {
      await db.insert(retentionRuns).values({ businessId, dataClass, rowsDeleted, olderThan });
    }
  }

  return outcomes;
}

/**
 * The deletes themselves, one statement per class.
 *
 * Written out rather than generated from a table of names, because each one has
 * a different idea of what "old" means and a different column to measure it by
 * — and a generic version would be a string-built query over a table name,
 * which is the shape of an injection even when today's callers are safe.
 */
async function deleteBatch(
  db: Database,
  dataClass: RetentionDataClass,
  businessId: string,
  olderThan: Date,
): Promise<number> {
  const business = sql`${businessId}::uuid`;
  const cutoff = sql`${olderThan}::timestamptz`;
  const limit = sql`${RETENTION_BATCH}`;

  switch (dataClass) {
    case 'notification_deliveries':
      return count(
        db,
        sql`delete from notification_deliveries where id in (
              select id from notification_deliveries
               where business_id = ${business} and created_at < ${cutoff}
               limit ${limit})`,
      );

    case 'resolved_alerts':
      // Only resolved ones. An outstanding alert is not history however old it
      // is, and deleting one because it has been ignored for six months would
      // remove the evidence that it was ignored for six months.
      return count(
        db,
        sql`delete from operator_alerts where id in (
              select id from operator_alerts
               where business_id = ${business}
                 and resolved_at is not null and resolved_at < ${cutoff}
               limit ${limit})`,
      );

    case 'ai_suggestions':
      return count(
        db,
        sql`delete from ai_suggestions where id in (
              select id from ai_suggestions
               where business_id = ${business} and requested_at < ${cutoff}
               limit ${limit})`,
      );

    case 'convergence_samples':
      // Settled ones only. A sample still pending is an outstanding change, and
      // deleting it because it is old would remove the record of the slowest
      // change this installation has ever had — which is the one the pilot bar
      // most needs to see.
      return count(
        db,
        sql`delete from convergence_samples where id in (
              select id from convergence_samples
               where business_id = ${business}
                 and outcome <> 'pending' and noticed_at < ${cutoff}
               limit ${limit})`,
      );

    case 'withheld_writes':
      return count(
        db,
        sql`delete from pilot_withheld_writes where id in (
              select id from pilot_withheld_writes
               where business_id = ${business} and withheld_at < ${cutoff}
               limit ${limit})`,
      );

    case 'webhook_deliveries':
      // The body is cleared rather than the row deleted. The delivery record is
      // what deduplicates a replayed webhook, and dropping it would let a
      // provider redeliver a six-week-old order and have it processed as new.
      // What section 13 requires gone is the body, and that is what goes.
      return count(
        db,
        sql`update webhook_deliveries set raw_body = null, headers = '{}'::jsonb
             where id in (
               select id from webhook_deliveries
                where business_id = ${business}
                  and received_at < ${cutoff}
                  and (raw_body is not null or headers <> '{}'::jsonb)
                limit ${limit})`,
      );

    case 'processed_events':
      return count(
        db,
        sql`delete from processed_events where id in (
              select id from processed_events
               where business_id = ${business} and processed_at < ${cutoff}
               limit ${limit})`,
      );
  }
}

async function count(db: Database, statement: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute(statement);
  return result.rowCount ?? 0;
}
