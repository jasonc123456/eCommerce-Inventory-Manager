import { sql } from 'drizzle-orm';

import type { PilotExecutor } from './executor';
import { measureSlo, type SloReport, type SloWindow } from './slo';
import { readStage, type StageView } from './stages';

/**
 * Section 1's version 1 acceptance bar, as eight answerable questions.
 *
 * "Version 1 requires a 30-day live pilot demonstrating" — and then a list. This
 * module turns that list into verdicts backed by retained evidence, which is
 * what section 36's M9 exit gate asks for: "every section 1 pilot criterion and
 * AC-01 through AC-20 pass with retained evidence".
 *
 * There are three verdicts, not two, and the third is the important one.
 *
 * `met` and `not_met` are what a criterion does when there is evidence either
 * way. `undemonstrated` is what it does when there is not: no oversale has been
 * reviewed yet, no outage drill has been run, too few changes have settled to
 * distinguish 95% from 94%. A two-verdict scheme has to fold that case into one
 * of the others, and both choices are wrong — calling it met passes a bar nobody
 * cleared, calling it failed condemns a pilot for being young.
 *
 * So a criterion nobody has evidence for says so, and the release gate treats
 * `undemonstrated` exactly as it treats `not_met`: version 1 does not ship.
 * The difference is what an operator does about it, which is the entire point of
 * telling them apart.
 */

export const PILOT_CRITERIA = [
  'no_oversale',
  'service_objective',
  'event_integrity',
  'outage_recovery',
  'traceability',
  'retryable_failures',
  'restore_demonstrated',
  'clean_install',
] as const;
export type PilotCriterionId = (typeof PILOT_CRITERIA)[number];

export type CriterionVerdict = 'met' | 'not_met' | 'undemonstrated';

export interface CriterionResult {
  readonly id: PilotCriterionId;
  /** Section 1's own words, so the screen quotes the bar rather than paraphrasing it. */
  readonly statement: string;
  readonly verdict: CriterionVerdict;
  /** One sentence an operator can act on. */
  readonly detail: string;
  /** What to do when it is not met. Empty when it is. */
  readonly nextStep: string;
}

/** Section 1: "Version 1 requires a 30-day live pilot". */
export const PILOT_DURATION_DAYS = 30;

/**
 * The fewest settled changes that can demonstrate a 95% objective.
 *
 * Below a hundred, one slow change moves attainment by more than a percentage
 * point, so "95%" and "94%" are not distinguishable and a passing figure is an
 * artifact of the sample size. A pilot at section 1's tested baseline — 500
 * orders a day — passes this within hours; one that does not reach it in thirty
 * days has not exercised the system enough to have measured anything.
 */
export const MIN_SETTLED_SAMPLES = 100;

export interface PilotReport {
  readonly businessId: string;
  readonly window: SloWindow;
  readonly stage: StageView;
  /** Days since the business first left `observe`, or null if it never has. */
  readonly elapsedDays: number | null;
  readonly durationMet: boolean;
  readonly slo: SloReport;
  readonly criteria: readonly CriterionResult[];
  /**
   * True only when the pilot has run its thirty days and every criterion is met.
   * Section 36's exit gate, in one boolean, with nothing rounded in its favour.
   */
  readonly passes: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The current time, according to the database, rounded up to the next
 * millisecond.
 *
 * Two separate reasons, and the second is subtle enough to be worth the whole
 * comment.
 *
 * Every timestamp this report compares — an incident's `detected_at`, a sample's
 * `noticed_at`, a drill's `performed_at` — was written by PostgreSQL's clock. In
 * a Compose deployment the web tier and the database are two containers, so
 * asking Node what time it is to bound a window over PostgreSQL's timestamps
 * means clock skew can drop the most recent row out of its own window.
 *
 * And PostgreSQL keeps timestamps to the microsecond while JavaScript's `Date`
 * keeps them to the millisecond. Converting `now()` into a `Date` therefore
 * truncates *downwards*, which for an exclusive upper bound is the wrong
 * direction: a row written at 46.381241 falls outside a window ending at a
 * reading of 46.381500, because that reading became 46.381. The window excludes
 * a row that happened before it.
 *
 * Rounding up costs at most one millisecond of future — during which nothing has
 * happened yet, so nothing can be wrongly included — and removes a whole class
 * of "the incident I just filed is not on the screen".
 *
 * One extra round trip per report, which is a report an operator loads by hand.
 */
async function databaseNow(db: PilotExecutor): Promise<Date> {
  const rows = await db.execute<{ now: string | Date }>(sql`select now() as now`);
  const value = rows.rows[0]?.now;

  if (value === undefined) {
    throw new Error('the database did not report the time');
  }

  const truncated = value instanceof Date ? value : new Date(value);

  return new Date(truncated.getTime() + 1);
}

/**
 * Assembles the whole bar for one business.
 *
 * Every criterion is evaluated even when an earlier one has already failed. An
 * operator fixing a pilot wants the full list — stopping at the first failure
 * would turn a thirty-day pilot into a sequence of thirty-day pilots.
 */
export async function assessPilot(
  db: PilotExecutor,
  input: {
    readonly businessId: string;
    /** Defaults to the pilot's own start, or thirty days back if it has none. */
    readonly window?: SloWindow;
    readonly now?: Date;
  },
): Promise<PilotReport> {
  const now = input.now ?? (await databaseNow(db));
  const stage = await readStage(db, input.businessId);

  const window = input.window ?? {
    from: stage.pilotStartedAt ?? new Date(now.getTime() - PILOT_DURATION_DAYS * MS_PER_DAY),
    to: now,
  };

  const elapsedDays =
    stage.pilotStartedAt === null
      ? null
      : (now.getTime() - stage.pilotStartedAt.getTime()) / MS_PER_DAY;

  const slo = await measureSlo(db, { businessId: input.businessId, window });

  const criteria = [
    await noOversale(db, input.businessId, window),
    serviceObjective(slo),
    await eventIntegrity(db, input.businessId, window),
    await drillCriterion(db, {
      id: 'outage_recovery',
      kind: 'outage_recovery',
      window,
      statement:
        'Recovery from a 24-hour application or provider outage without direct database repair.',
      nextStep:
        'Run the outage drill in docs/operations/pilot.md, then record it on the pilot screen.',
    }),
    await traceability(db, input.businessId, window),
    await retryableFailures(db, input.businessId, window),
    await restoreDemonstrated(db, window),
    await drillCriterion(db, {
      id: 'clean_install',
      kind: 'clean_install',
      window,
      statement: 'A clean deployment from the published documentation.',
      nextStep:
        'Install onto a fresh machine following docs/operations/install.md alone, then record it.',
    }),
  ];

  const durationMet = elapsedDays !== null && elapsedDays >= PILOT_DURATION_DAYS;

  return {
    businessId: input.businessId,
    window,
    stage,
    elapsedDays,
    durationMet,
    slo,
    criteria,
    passes: durationMet && criteria.every((criterion) => criterion.verdict === 'met'),
  };
}

// ---------------------------------------------------------------------------
// 1. No oversale attributable to a synchronization defect
// ---------------------------------------------------------------------------

async function noOversale(
  db: PilotExecutor,
  businessId: string,
  window: SloWindow,
): Promise<CriterionResult> {
  const rows = await db.execute<{ defects: string | number; unreviewed: string | number }>(sql`
    select count(*) filter (where classification = 'defect') as defects,
           count(*) filter (where classification = 'unreviewed') as unreviewed
      from pilot_incidents
     where business_id = ${businessId}::uuid
       and kind = 'oversale'
       and detected_at >= ${window.from.toISOString()}::timestamptz
       and detected_at <  ${window.to.toISOString()}::timestamptz
  `);

  const defects = Number(rows.rows[0]?.defects ?? 0);
  const unreviewed = Number(rows.rows[0]?.unreviewed ?? 0);

  const statement = 'No oversale attributable to a synchronization defect.';

  if (defects > 0) {
    return {
      id: 'no_oversale',
      statement,
      verdict: 'not_met',
      detail: `${String(defects)} oversale${defects === 1 ? '' : 's'} classified as a defect.`,
      nextStep: 'Fix the defect, then restart the pilot window from the fix.',
    };
  }

  if (unreviewed > 0) {
    return {
      id: 'no_oversale',
      statement,
      verdict: 'undemonstrated',
      detail: `${String(unreviewed)} oversale${unreviewed === 1 ? ' is' : 's are'} still unreviewed.`,
      nextStep: 'Classify each one: a defect, not a defect, or the provider’s.',
    };
  }

  return {
    id: 'no_oversale',
    statement,
    verdict: 'met',
    detail: 'Every oversale in this window was reviewed and none was a defect.',
    nextStep: '',
  };
}

// ---------------------------------------------------------------------------
// 2. The two-minute objective
// ---------------------------------------------------------------------------

function serviceObjective(slo: SloReport): CriterionResult {
  const statement = 'At least 95% of healthy-path inventory updates meeting the two-minute target.';
  const settled = slo.met + slo.missed;

  if (settled < MIN_SETTLED_SAMPLES) {
    return {
      id: 'service_objective',
      statement,
      verdict: 'undemonstrated',
      detail:
        `${String(settled)} changes have settled; ` +
        `${String(MIN_SETTLED_SAMPLES)} are needed before a 95% figure means anything.`,
      nextStep: 'Keep the pilot running, or widen the stage so more mappings are exercised.',
    };
  }

  const percent = ((slo.attainment ?? 0) * 100).toFixed(1);

  return {
    id: 'service_objective',
    statement,
    verdict: slo.meetsTarget ? 'met' : 'not_met',
    detail:
      `${percent}% of ${String(settled)} changes reached their channel in time` +
      (slo.excluded === 0 ? '.' : `, with ${String(slo.excluded)} excluded for provider health.`),
    nextStep: slo.meetsTarget ? '' : 'Look at the slowest mappings on the pilot screen.',
  };
}

// ---------------------------------------------------------------------------
// 3. Duplicate, delayed, replayed, and out-of-order events
// ---------------------------------------------------------------------------

/**
 * Two questions, and the criterion needs both answered.
 *
 * Did the ledger stay consistent — every materialized balance equal to the sum
 * of the entries explaining it? And did the pilot actually encounter a reordered
 * or superseded event, so that consistency means something?
 *
 * Without the second question a pilot that never saw a duplicate would report
 * this criterion as met, having demonstrated nothing at all.
 */
async function eventIntegrity(
  db: PilotExecutor,
  businessId: string,
  window: SloWindow,
): Promise<CriterionResult> {
  const rows = await db.execute<{ drifted: string | number; reordered: string | number }>(sql`
    with balances as (
      select b.canonical_item_id, b.location_id, b.on_hand,
             coalesce((
               select sum(l.quantity_delta)
                 from inventory_ledger l
                where l.business_id = b.business_id
                  and l.canonical_item_id = b.canonical_item_id
                  and l.location_id = b.location_id
             ), 0) as ledger_sum
        from location_balances b
       where b.business_id = ${businessId}::uuid
    )
    select
      (select count(*) from balances where on_hand <> ledger_sum) as drifted,
      (
        select count(*)
          from convergence_samples s
         where s.business_id = ${businessId}::uuid
           and s.outcome = 'superseded'
           and s.noticed_at >= ${window.from.toISOString()}::timestamptz
           and s.noticed_at <  ${window.to.toISOString()}::timestamptz
      ) + (
        select count(*)
          from channel_write_attempts a
         where a.business_id = ${businessId}::uuid
           and a.outcome = 'superseded'
           and a.started_at >= ${window.from.toISOString()}::timestamptz
           and a.started_at <  ${window.to.toISOString()}::timestamptz
      ) as reordered
  `);

  const drifted = Number(rows.rows[0]?.drifted ?? 0);
  const reordered = Number(rows.rows[0]?.reordered ?? 0);

  const statement =
    'Duplicate, delayed, replayed, and out-of-order events not corrupting inventory.';

  if (drifted > 0) {
    return {
      id: 'event_integrity',
      statement,
      verdict: 'not_met',
      detail: `${String(drifted)} balances disagree with the ledger entries explaining them.`,
      nextStep:
        'This is corruption, not drift. Stop the pilot and investigate before writing more.',
    };
  }

  if (reordered === 0) {
    return {
      id: 'event_integrity',
      statement,
      verdict: 'undemonstrated',
      detail: 'The ledger is consistent, but no reordered or superseded event occurred to test it.',
      nextStep: 'Keep running: duplicates arrive on their own once traffic is real.',
    };
  }

  return {
    id: 'event_integrity',
    statement,
    verdict: 'met',
    detail:
      `${String(reordered)} reordered or superseded events were handled, ` +
      'and every balance still equals the sum of its ledger entries.',
    nextStep: '',
  };
}

// ---------------------------------------------------------------------------
// 4 and 8. The drills
// ---------------------------------------------------------------------------

async function drillCriterion(
  db: PilotExecutor,
  input: {
    readonly id: PilotCriterionId;
    readonly kind: string;
    readonly window: SloWindow;
    readonly statement: string;
    readonly nextStep: string;
  },
): Promise<CriterionResult> {
  const rows = await db.execute<{ succeeded: string | number; failed: string | number }>(sql`
    select count(*) filter (where succeeded) as succeeded,
           count(*) filter (where not succeeded) as failed
      from pilot_drills
     where kind = ${input.kind}
       and performed_at >= ${input.window.from.toISOString()}::timestamptz
       and performed_at <  ${input.window.to.toISOString()}::timestamptz
  `);

  const succeeded = Number(rows.rows[0]?.succeeded ?? 0);
  const failed = Number(rows.rows[0]?.failed ?? 0);

  if (succeeded > 0) {
    return {
      id: input.id,
      statement: input.statement,
      verdict: 'met',
      detail:
        failed === 0
          ? 'Performed and recorded during this pilot.'
          : `Performed successfully after ${String(failed)} earlier attempt${failed === 1 ? '' : 's'}.`,
      nextStep: '',
    };
  }

  if (failed > 0) {
    return {
      id: input.id,
      statement: input.statement,
      verdict: 'not_met',
      detail: `${String(failed)} attempt${failed === 1 ? '' : 's'} recorded, none successful.`,
      nextStep: input.nextStep,
    };
  }

  return {
    id: input.id,
    statement: input.statement,
    verdict: 'undemonstrated',
    detail: 'Not attempted during this pilot.',
    nextStep: input.nextStep,
  };
}

// ---------------------------------------------------------------------------
// 5. Complete traceability for inventory writes
// ---------------------------------------------------------------------------

/**
 * Two gaps, both of which mean "something moved and nothing says why".
 *
 * A ledger entry with no actor, no reason, and no correlation id is stock that
 * changed for reasons nobody recorded. A provider write with no convergence
 * sample is a number sent to a channel with no record of what asked for it.
 */
async function traceability(
  db: PilotExecutor,
  businessId: string,
  window: SloWindow,
): Promise<CriterionResult> {
  const rows = await db.execute<{
    unexplained: string | number;
    unsampled: string | number;
    entries: string | number;
  }>(sql`
    select
      (
        select count(*)
          from inventory_ledger l
         where l.business_id = ${businessId}::uuid
           and l.recorded_at >= ${window.from.toISOString()}::timestamptz
           and l.recorded_at <  ${window.to.toISOString()}::timestamptz
           and l.actor_user_id is null
           and l.reason is null
           and l.correlation_id is null
      ) as unexplained,
      (
        select count(*)
          from channel_write_attempts a
         where a.business_id = ${businessId}::uuid
           and a.started_at >= ${window.from.toISOString()}::timestamptz
           and a.started_at <  ${window.to.toISOString()}::timestamptz
           and not exists (
             select 1 from convergence_samples s
              where s.mapping_id = a.mapping_id
                and s.target_version = a.target_version
           )
      ) as unsampled,
      (
        select count(*)
          from inventory_ledger l
         where l.business_id = ${businessId}::uuid
           and l.recorded_at >= ${window.from.toISOString()}::timestamptz
           and l.recorded_at <  ${window.to.toISOString()}::timestamptz
      ) as entries
  `);

  const unexplained = Number(rows.rows[0]?.unexplained ?? 0);
  const unsampled = Number(rows.rows[0]?.unsampled ?? 0);
  const entries = Number(rows.rows[0]?.entries ?? 0);

  const statement = 'Complete traceability for inventory writes.';

  if (unexplained > 0 || unsampled > 0) {
    return {
      id: 'traceability',
      statement,
      verdict: 'not_met',
      detail:
        `${String(unexplained)} ledger entries explain nothing, ` +
        `and ${String(unsampled)} provider writes have no recorded cause.`,
      nextStep: 'Every movement needs an actor, a reason, or a correlation id.',
    };
  }

  if (entries === 0) {
    return {
      id: 'traceability',
      statement,
      verdict: 'undemonstrated',
      detail: 'No stock moved in this window, so nothing was traced.',
      nextStep: 'Keep the pilot running.',
    };
  }

  return {
    id: 'traceability',
    statement,
    verdict: 'met',
    detail: `All ${String(entries)} ledger entries carry an explanation, and every write has a cause.`,
    nextStep: '',
  };
}

// ---------------------------------------------------------------------------
// 6. Visible and safely retryable failures
// ---------------------------------------------------------------------------

/**
 * A failure nobody was told about is not visible, whatever the screen shows.
 *
 * Every dead-lettered job raises an alert carrying that job's id, so the check
 * is for dead jobs with no alert attached. Retryability is structural — the
 * dead-letter list replays them — so what is worth checking each pilot is the
 * half that depends on the alerting tier still working.
 */
async function retryableFailures(
  db: PilotExecutor,
  businessId: string,
  window: SloWindow,
): Promise<CriterionResult> {
  const rows = await db.execute<{ silent: string | number; dead: string | number }>(sql`
    select
      count(*) filter (
        where not exists (
          select 1 from operator_alerts al
           where al.job_id = j.id and al.kind = 'job_dead_lettered'
        )
      ) as silent,
      count(*) as dead
      from background_jobs j
     where j.business_id = ${businessId}::uuid
       and j.status = 'dead'
       and j.updated_at >= ${window.from.toISOString()}::timestamptz
       and j.updated_at <  ${window.to.toISOString()}::timestamptz
  `);

  const silent = Number(rows.rows[0]?.silent ?? 0);
  const dead = Number(rows.rows[0]?.dead ?? 0);

  const statement = 'Visible and safely retryable failures.';

  if (silent > 0) {
    return {
      id: 'retryable_failures',
      statement,
      verdict: 'not_met',
      detail: `${String(silent)} of ${String(dead)} dead-lettered jobs raised no alert.`,
      nextStep: 'A failure nobody hears about is not a visible one. Check the alerting path.',
    };
  }

  if (dead === 0) {
    return {
      id: 'retryable_failures',
      statement,
      verdict: 'undemonstrated',
      detail: 'Nothing failed badly enough to be dead-lettered, so nothing tested this.',
      nextStep: 'Keep running, or exercise it deliberately with a provider outage drill.',
    };
  }

  return {
    id: 'retryable_failures',
    statement,
    verdict: 'met',
    detail: `All ${String(dead)} dead-lettered jobs raised an alert and remain replayable.`,
    nextStep: '',
  };
}

// ---------------------------------------------------------------------------
// 7. A demonstrated backup restoration
// ---------------------------------------------------------------------------

/**
 * Read from `backup_runs`, where M8 already records it.
 *
 * The claim recorded there is stronger than a drill note would be: it names the
 * specific artifact that was restored, so "we tested a restore" is a statement
 * about a file somebody still has rather than about the calendar.
 */
async function restoreDemonstrated(db: PilotExecutor, window: SloWindow): Promise<CriterionResult> {
  const rows = await db.execute<{ verified: string | number }>(sql`
    select count(*) as verified
      from backup_runs
     where restore_verified_at is not null
       and restore_verified_at >= ${window.from.toISOString()}::timestamptz
       and restore_verified_at <  ${window.to.toISOString()}::timestamptz
  `);

  const verified = Number(rows.rows[0]?.verified ?? 0);
  const statement = 'A demonstrated backup restoration.';

  if (verified === 0) {
    return {
      id: 'restore_demonstrated',
      statement,
      verdict: 'undemonstrated',
      detail: 'No backup has been restored and verified during this pilot.',
      nextStep:
        'Run ./scripts/restore.sh --verify against a recent backup, into an empty database.',
    };
  }

  return {
    id: 'restore_demonstrated',
    statement,
    verdict: 'met',
    detail: `${String(verified)} backup${verified === 1 ? '' : 's'} restored and verified.`,
    nextStep: '',
  };
}
