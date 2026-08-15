import { sql } from 'drizzle-orm';

import type { PilotExecutor } from './executor';

/**
 * Section 1's service objective, computed from retained samples.
 *
 * "With a target interval of thirty seconds or faster and healthy external APIs,
 * at least 95% of eligible inventory changes should reach every affected channel
 * within two minutes and 99% within five minutes."
 *
 * Three clauses in that sentence do real work, and each one is a place a
 * measurement could quietly become flattering.
 *
 * "With a target interval of thirty seconds or faster." An owner who chooses a
 * slower interval has chosen a slower objective — section 1 says the configured
 * delay "is added to the displayed service objective". So the allowance is two
 * minutes plus whatever the owner asked to wait beyond the thirty-second
 * baseline, per connection. Note that it is the *configured* interval that moves
 * the target, never the effective one: adaptive throttling is the system
 * protecting itself against a provider limit, and letting that widen the
 * objective would mean the target loosened exactly when performance degraded.
 *
 * "Healthy external APIs." A sample delayed by a provider outage carries an
 * exclusion reason. It is still counted and still shown — see below.
 *
 * "Eligible inventory changes." Imports, activations, and full reconciliations
 * are out of scope by section 1's own list, decided by a generated column so the
 * classification cannot be set per row.
 *
 * Why the excluded samples are in the report.
 *
 * Any percentage survives contact with enough exclusions. A report that filtered
 * silently would be unfalsifiable, so this one carries `excluded` and
 * `outOfScope` alongside `met` and `missed`, and the screen prints them next to
 * the headline figure. A reader is free to decide the exclusions are too
 * generous; what they cannot do is fail to notice them.
 */

/** Section 1's headline: two minutes. */
export const SLO_TARGET_MS = 2 * 60 * 1000;

/** And the share of changes that must meet it. */
export const SLO_TARGET_ATTAINMENT = 0.95;

/** Section 1's tail: five minutes. */
export const SLO_TAIL_MS = 5 * 60 * 1000;

export const SLO_TAIL_ATTAINMENT = 0.99;

/**
 * The cadence the two-minute objective assumes.
 *
 * Section 1 states the objective "with a target interval of thirty seconds or
 * faster", so a connection configured faster than this gets no credit for it and
 * one configured slower gets exactly the difference.
 */
export const BASELINE_INTERVAL_SECONDS = 30;

export interface SloWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface ExclusionCount {
  readonly reason: string;
  readonly samples: number;
}

export interface SloReport {
  readonly window: SloWindow;

  /** Converged inside the allowance. */
  readonly met: number;
  /**
   * Converged outside it, or abandoned.
   *
   * An abandoned sample — a change accepted and never delivered — counts as a
   * miss. Dropping it would let the percentage improve every time something
   * broke badly enough to lose the change entirely.
   */
  readonly missed: number;
  /** Still outstanding. Neither met nor missed yet; reported so it is visible. */
  readonly pending: number;
  /** Overtaken by a newer target. Measured through its successor, not here. */
  readonly superseded: number;

  /** In scope, but delayed by something section 1 excludes. */
  readonly excluded: number;
  readonly exclusions: readonly ExclusionCount[];

  /** Imports, activations, and reconciliations. Section 1 does not measure these. */
  readonly outOfScope: number;

  /** met / (met + missed), or null when nothing settled in the window. */
  readonly attainment: number | null;
  /** The same, against the five-minute tail. */
  readonly tailAttainment: number | null;

  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;

  readonly meetsTarget: boolean;
  readonly meetsTail: boolean;
}

interface SloRow extends Record<string, unknown> {
  met: string | number;
  missed: string | number;
  pending: string | number;
  superseded: string | number;
  excluded: string | number;
  out_of_scope: string | number;
  tail_met: string | number;
  p50: string | number | null;
  p95: string | number | null;
  p99: string | number | null;
}

function count(value: string | number): number {
  return Number(value);
}

function millis(value: string | number | null): number | null {
  return value === null ? null : Math.round(Number(value));
}

/**
 * Measures one business over one window.
 *
 * A single statement rather than several, because the counts have to describe
 * the same set of rows. Two queries a second apart over a live pilot would
 * produce a numerator and a denominator that disagree about how many samples
 * exist, and the resulting percentage would be wrong in a way nobody could see.
 */
export async function measureSlo(
  db: PilotExecutor,
  input: { readonly businessId: string; readonly window: SloWindow },
): Promise<SloReport> {
  const rows = await db.execute<SloRow>(sql`
    with scoped as (
      select s.outcome,
             s.latency_ms,
             s.excluded_reason,
             s.in_slo_scope,
             -- Section 1's allowance for this sample: two minutes, plus the
             -- delay this connection's owner deliberately configured beyond the
             -- thirty-second baseline. target_interval_seconds is the owner's
             -- choice; effective_interval_seconds is adaptive throttling and is
             -- deliberately not consulted.
             ${SLO_TARGET_MS} + greatest(
               0,
               coalesce(c.target_interval_seconds, ${BASELINE_INTERVAL_SECONDS})
                 - ${BASELINE_INTERVAL_SECONDS}
             ) * 1000 as allowance_ms,
             ${SLO_TAIL_MS} + greatest(
               0,
               coalesce(c.target_interval_seconds, ${BASELINE_INTERVAL_SECONDS})
                 - ${BASELINE_INTERVAL_SECONDS}
             ) * 1000 as tail_allowance_ms
        from convergence_samples s
        left join connection_sync_settings c on c.connection_id = s.connection_id
       where s.business_id = ${input.businessId}::uuid
         and s.noticed_at >= ${input.window.from.toISOString()}::timestamptz
         and s.noticed_at <  ${input.window.to.toISOString()}::timestamptz
    ),
    counted as (
      select
        count(*) filter (
          where in_slo_scope and excluded_reason is null
            and outcome = 'converged' and latency_ms <= allowance_ms
        ) as met,
        count(*) filter (
          where in_slo_scope and excluded_reason is null
            and (
              (outcome = 'converged' and latency_ms > allowance_ms)
              or outcome = 'abandoned'
            )
        ) as missed,
        count(*) filter (
          where in_slo_scope and excluded_reason is null
            and outcome = 'converged' and latency_ms <= tail_allowance_ms
        ) as tail_met,
        count(*) filter (where in_slo_scope and outcome = 'pending') as pending,
        count(*) filter (where in_slo_scope and outcome = 'superseded') as superseded,
        count(*) filter (where in_slo_scope and excluded_reason is not null) as excluded,
        count(*) filter (where not in_slo_scope) as out_of_scope,
        percentile_cont(0.5) within group (
          order by latency_ms
        ) filter (
          where in_slo_scope and excluded_reason is null and outcome = 'converged'
        ) as p50,
        percentile_cont(0.95) within group (
          order by latency_ms
        ) filter (
          where in_slo_scope and excluded_reason is null and outcome = 'converged'
        ) as p95,
        percentile_cont(0.99) within group (
          order by latency_ms
        ) filter (
          where in_slo_scope and excluded_reason is null and outcome = 'converged'
        ) as p99
      from scoped
    )
    select * from counted
  `);

  const row = rows.rows[0];

  if (row === undefined) {
    throw new Error('measuring the service objective returned nothing');
  }

  const met = count(row.met);
  const missed = count(row.missed);
  const settled = met + missed;
  const tailMet = count(row.tail_met);

  const exclusions = await readExclusions(db, input);

  const attainment = settled === 0 ? null : met / settled;
  const tailAttainment = settled === 0 ? null : tailMet / settled;

  return {
    window: input.window,
    met,
    missed,
    pending: count(row.pending),
    superseded: count(row.superseded),
    excluded: count(row.excluded),
    exclusions,
    outOfScope: count(row.out_of_scope),
    attainment,
    tailAttainment,
    p50Ms: millis(row.p50),
    p95Ms: millis(row.p95),
    p99Ms: millis(row.p99),
    // An empty window has not failed the objective. It has not demonstrated it
    // either, which is what the pilot criteria check separately: section 1 wants
    // thirty days of evidence, and "no traffic" is not evidence of speed.
    meetsTarget: attainment === null ? false : attainment >= SLO_TARGET_ATTAINMENT,
    meetsTail: tailAttainment === null ? false : tailAttainment >= SLO_TAIL_ATTAINMENT,
  };
}

async function readExclusions(
  db: PilotExecutor,
  input: { readonly businessId: string; readonly window: SloWindow },
): Promise<readonly ExclusionCount[]> {
  const rows = await db.execute<{ excluded_reason: string; samples: string | number }>(sql`
    select excluded_reason, count(*) as samples
      from convergence_samples
     where business_id = ${input.businessId}::uuid
       and noticed_at >= ${input.window.from.toISOString()}::timestamptz
       and noticed_at <  ${input.window.to.toISOString()}::timestamptz
       and in_slo_scope
       and excluded_reason is not null
     group by excluded_reason
     order by count(*) desc, excluded_reason
  `);

  return rows.rows.map((row) => ({ reason: row.excluded_reason, samples: Number(row.samples) }));
}
