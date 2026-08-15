import type { PilotStage } from '@eim/db';
import { sql } from 'drizzle-orm';

import type { PilotExecutor } from './executor';

/**
 * The staged-connection gate (section 36, M9).
 *
 * Four stages, one question: may this mapping be written to a live provider yet?
 *
 * The whole design turns on where the ceiling is enforced. It would be natural
 * to check "are fewer than N mappings enrolled" at write time, and it would be
 * wrong: with three mappings enrolled under a stage that permits one, whichever
 * write arrives first wins, and which listing the pilot is actually exercising
 * becomes a matter of timing. So the ceiling is enforced at enrollment — you
 * cannot enroll past it, and you cannot narrow a stage while more mappings are
 * enrolled than the narrower stage allows.
 *
 * That leaves the invariant "enrolled ≤ ceiling" true at all times, and reduces
 * the write-time question to a single lookup with no arithmetic and no race.
 */

export interface StageView {
  readonly stage: PilotStage;
  readonly cohortLimit: number | null;
  readonly pilotStartedAt: Date | null;
  readonly enteredAt: Date;
  readonly note: string | null;
  readonly enrolled: number;
}

/**
 * How many mappings a stage permits.
 *
 * `null` means no ceiling. `0` means none may be written at all, which is what
 * `observe` is for: everything computed, nothing sent.
 */
export function stageCeiling(stage: PilotStage, cohortLimit: number | null): number | null {
  switch (stage) {
    case 'observe':
      return 0;
    case 'single':
      return 1;
    case 'cohort':
      return cohortLimit;
    case 'full':
      return null;
  }
}

/** Whether a stage writes to providers at all. */
export function stageWrites(stage: PilotStage): boolean {
  return stage !== 'observe';
}

interface StageRow extends Record<string, unknown> {
  stage: PilotStage;
  cohort_limit: number | null;
  pilot_started_at: string | Date | null;
  entered_at: string | Date;
  note: string | null;
  enrolled: string | number;
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Reads a business's stage.
 *
 * A business with no row is a full one. Section 36's staging is something an
 * operator opts into for a pilot; an installation that never ran one must not
 * find its synchronization silently switched off by an upgrade.
 */
export async function readStage(db: PilotExecutor, businessId: string): Promise<StageView> {
  const rows = await db.execute<StageRow>(sql`
    select s.stage, s.cohort_limit, s.pilot_started_at, s.entered_at, s.note,
           (select count(*) from pilot_enrollments e where e.business_id = s.business_id) as enrolled
      from business_pilot_stages s
     where s.business_id = ${businessId}::uuid
  `);

  const row = rows.rows[0];

  if (row === undefined) {
    return {
      stage: 'full',
      cohortLimit: null,
      pilotStartedAt: null,
      enteredAt: new Date(0),
      note: null,
      enrolled: 0,
    };
  }

  return {
    stage: row.stage,
    cohortLimit: row.cohort_limit,
    pilotStartedAt: row.pilot_started_at === null ? null : asDate(row.pilot_started_at),
    enteredAt: asDate(row.entered_at),
    note: row.note,
    enrolled: Number(row.enrolled),
  };
}

export type WriteDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly stage: PilotStage; readonly reason: string };

/**
 * Whether one mapping may be written now.
 *
 * One statement, because this is on the path of every provider write and a
 * second round trip per mapping is a cost the whole synchronization tier pays.
 */
export async function mayWrite(
  db: PilotExecutor,
  input: { readonly businessId: string; readonly mappingId: string },
): Promise<WriteDecision> {
  const rows = await db.execute<{ stage: PilotStage; enrolled: boolean }>(sql`
    select s.stage,
           exists (
             select 1 from pilot_enrollments e
              where e.business_id = s.business_id and e.mapping_id = ${input.mappingId}::uuid
           ) as enrolled
      from business_pilot_stages s
     where s.business_id = ${input.businessId}::uuid
  `);

  const row = rows.rows[0];

  if (row === undefined || row.stage === 'full') {
    return { allowed: true };
  }

  if (row.stage === 'observe') {
    return {
      allowed: false,
      stage: row.stage,
      reason: 'this business is observing: targets are computed but nothing is sent',
    };
  }

  if (row.enrolled) {
    return { allowed: true };
  }

  return {
    allowed: false,
    stage: row.stage,
    reason: 'this mapping is not enrolled in the pilot',
  };
}

/**
 * Records a write the gate stopped, with the number it would have sent.
 *
 * The point of the pilot's first stage is this table. An operator watching a
 * week of these against a live catalogue learns what the system would have done
 * with no listing at risk, which is a far better basis for widening the stage
 * than a test suite passing.
 */
export async function recordWithheld(
  db: PilotExecutor,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly connectionId: string;
    readonly intendedQuantity: number;
    readonly observedQuantity: number | null;
    readonly stage: PilotStage;
    readonly reason: string;
  },
): Promise<void> {
  await db.execute(sql`
    insert into pilot_withheld_writes
      (business_id, mapping_id, connection_id, intended_quantity, observed_quantity, stage, reason)
    values (${input.businessId}::uuid, ${input.mappingId}::uuid, ${input.connectionId}::uuid,
            ${input.intendedQuantity}, ${input.observedQuantity}, ${input.stage}, ${input.reason})
  `);
}

export type StageChange =
  | { readonly changed: true; readonly stage: StageView }
  | { readonly changed: false; readonly reason: string };

/**
 * Moves a business to a different stage.
 *
 * Two rules, both refusals rather than silent corrections.
 *
 * Narrowing below what is already enrolled is refused. The alternative is
 * choosing which enrollments to drop, and there is no basis on which to choose:
 * the operator knows which listing they wanted to keep exercising and this code
 * does not.
 *
 * `pilot_started_at` is stamped by the first transition out of `observe` and
 * never afterwards. Section 1's thirty days are measured from the first moment a
 * real provider could be written to, and a start date somebody can set is a
 * thirty-day pilot that can be declared over on day three.
 */
export async function setStage(
  db: PilotExecutor,
  input: {
    readonly businessId: string;
    readonly stage: PilotStage;
    readonly cohortLimit?: number;
    readonly actorUserId: string;
    readonly note?: string;
  },
): Promise<StageChange> {
  const cohortLimit = input.stage === 'cohort' ? (input.cohortLimit ?? null) : null;

  if (input.stage === 'cohort' && (cohortLimit === null || cohortLimit < 1)) {
    return { changed: false, reason: 'a cohort needs a ceiling of at least one mapping' };
  }

  const current = await readStage(db, input.businessId);
  const ceiling = stageCeiling(input.stage, cohortLimit);

  if (ceiling !== null && current.enrolled > ceiling) {
    return {
      changed: false,
      reason:
        `${String(current.enrolled)} mappings are enrolled and this stage permits ` +
        `${String(ceiling)}; remove the ones you do not want written first`,
    };
  }

  await db.execute(sql`
    insert into business_pilot_stages
      (business_id, stage, cohort_limit, pilot_started_at, entered_by_user_id, note)
    values (${input.businessId}::uuid, ${input.stage}, ${cohortLimit},
            ${input.stage === 'observe' ? null : sql`now()`},
            ${input.actorUserId}::uuid, ${input.note ?? null})
    on conflict (business_id) do update
       set stage = excluded.stage,
           cohort_limit = excluded.cohort_limit,
           -- Stamped once, by whichever transition first left observe.
           pilot_started_at = case
             when excluded.stage = 'observe' then business_pilot_stages.pilot_started_at
             else coalesce(business_pilot_stages.pilot_started_at, now())
           end,
           entered_at = now(),
           entered_by_user_id = excluded.entered_by_user_id,
           note = excluded.note
  `);

  return { changed: true, stage: await readStage(db, input.businessId) };
}

export type EnrollmentChange =
  | { readonly enrolled: true; readonly total: number }
  | { readonly enrolled: false; readonly reason: string };

/**
 * Hands one mapping over to the pilot.
 *
 * The ceiling is checked here, under a lock on the stage row, because two
 * operators enrolling at once must not both read "one enrolled, ceiling two" and
 * both succeed.
 */
export async function enroll(
  db: PilotExecutor,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly actorUserId: string;
  },
): Promise<EnrollmentChange> {
  const locked = await db.execute<{ stage: PilotStage; cohort_limit: number | null }>(sql`
    select stage, cohort_limit from business_pilot_stages
     where business_id = ${input.businessId}::uuid
       for update
  `);

  const row = locked.rows[0];

  if (row === undefined || row.stage === 'full') {
    return { enrolled: false, reason: 'this business writes to every mapping already' };
  }

  const ceiling = stageCeiling(row.stage, row.cohort_limit);

  const counted = await db.execute<{ total: string | number; already: boolean }>(sql`
    select count(*) as total,
           bool_or(mapping_id = ${input.mappingId}::uuid) as already
      from pilot_enrollments
     where business_id = ${input.businessId}::uuid
  `);

  const total = Number(counted.rows[0]?.total ?? 0);

  if (counted.rows[0]?.already === true) {
    return { enrolled: true, total };
  }

  if (ceiling !== null && total >= ceiling) {
    return {
      enrolled: false,
      reason:
        ceiling === 0
          ? 'this business is observing; move it to a writing stage first'
          : `this stage permits ${String(ceiling)} enrolled mapping${ceiling === 1 ? '' : 's'}`,
    };
  }

  await db.execute(sql`
    insert into pilot_enrollments (business_id, mapping_id, enrolled_by_user_id)
    values (${input.businessId}::uuid, ${input.mappingId}::uuid, ${input.actorUserId}::uuid)
    on conflict (business_id, mapping_id) do nothing
  `);

  return { enrolled: true, total: total + 1 };
}

/** Takes a mapping back out of the pilot. Always permitted: narrowing is safe. */
export async function unenroll(
  db: PilotExecutor,
  input: { readonly businessId: string; readonly mappingId: string },
): Promise<boolean> {
  const rows = await db.execute<{ mapping_id: string }>(sql`
    delete from pilot_enrollments
     where business_id = ${input.businessId}::uuid
       and mapping_id = ${input.mappingId}::uuid
    returning mapping_id
  `);

  return rows.rows.length > 0;
}
