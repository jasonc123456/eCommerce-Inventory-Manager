import type { ConvergenceOriginKind } from '@eim/db';
import { sql } from 'drizzle-orm';

import type { PilotExecutor } from './executor';

/**
 * Recording how long a change took to reach a channel (sections 1, 36).
 *
 * One sample per (mapping, target version), opened when a target is recorded and
 * settled when the provider acknowledges it. Every function here is written to
 * be called from inside the transaction that moved the stock, so a sample cannot
 * exist for a change that was rolled back.
 *
 * The clock starts at `noticedAt` — when the causing event became known to this
 * installation — rather than at the moment we computed a target. The difference
 * between those two is queue latency, which is ours, and excluding it would mean
 * measuring the pilot bar against everything except the part we control.
 */

export interface ChangeOrigin {
  readonly kind: ConvergenceOriginKind;
  /**
   * When the causing event became known here. Not when the provider says it
   * happened: a provider clock is not ours to measure against, and section 1's
   * objective is about our responsiveness, not theirs.
   */
  readonly noticedAt: Date;
}

/**
 * Where an origin comes from when a caller has none.
 *
 * Operator-initiated work genuinely originates now — the person clicked, and the
 * transaction is the response. Passing `now` for one of those is accurate rather
 * than flattering, which is why this exists and why it is not the default for
 * anything that arrives from a provider.
 */
export function operatorOrigin(
  kind: Extract<ConvergenceOriginKind, 'restock' | 'adjustment' | 'mapping_change' | 'manual'>,
  now: Date = new Date(),
): ChangeOrigin {
  return { kind, noticedAt: now };
}

export interface OpenSampleInput {
  readonly businessId: string;
  readonly mappingId: string;
  readonly connectionId: string;
  readonly targetVersion: number;
  readonly quantity: number;
  readonly origin: ChangeOrigin;
}

/**
 * Opens the sample for one change to one channel.
 *
 * `do nothing` on conflict, deliberately. A retry that re-records the same
 * target version is the same change still outstanding, and taking the later
 * `noticed_at` would restart the clock on a change that has been waiting — which
 * is the one circumstance where an accurate measurement matters most.
 */
export async function openSample(db: PilotExecutor, input: OpenSampleInput): Promise<void> {
  await db.execute(sql`
    insert into convergence_samples
      (business_id, mapping_id, connection_id, target_version, quantity,
       origin_kind, noticed_at)
    values (${input.businessId}::uuid, ${input.mappingId}::uuid, ${input.connectionId}::uuid,
            ${input.targetVersion}, ${input.quantity},
            ${input.origin.kind}, ${input.origin.noticedAt.toISOString()}::timestamptz)
    on conflict (mapping_id, target_version) do nothing
  `);
}

/**
 * Records that this version reached its channel.
 *
 * Called for an acknowledged write and for a suppressed no-op alike. A no-op is
 * a convergence: the channel already advertises the number the change asked for,
 * and a definition of "delivered" that excluded it would penalize the system for
 * being right in advance.
 */
export async function markConverged(
  db: PilotExecutor,
  input: { readonly mappingId: string; readonly targetVersion: number },
): Promise<void> {
  await db.execute(sql`
    update convergence_samples
       set outcome = 'converged',
           -- Never before it was noticed. A provider acknowledgement processed
           -- under a skewed clock would otherwise store a negative latency, and
           -- the check constraint would refuse the row outright.
           converged_at = greatest(now(), noticed_at)
     where mapping_id = ${input.mappingId}::uuid
       and target_version = ${input.targetVersion}
       and outcome = 'pending'
  `);
}

/**
 * Records that a newer target overtook this one before it landed.
 *
 * Not a miss. The change this version carried is subsumed by the version that
 * replaced it, and that version is measured from its own origin. Counting both
 * would charge a fast-moving item twice for one period of slowness.
 */
export async function markSuperseded(
  db: PilotExecutor,
  input: { readonly mappingId: string; readonly targetVersion: number },
): Promise<void> {
  await db.execute(sql`
    update convergence_samples
       set outcome = 'superseded'
     where mapping_id = ${input.mappingId}::uuid
       and target_version = ${input.targetVersion}
       and outcome = 'pending'
  `);
}

/**
 * Names a reason this sample should not count toward section 1's objective.
 *
 * Section 1 excludes "external provider outages or throttling". The exclusion is
 * recorded on the sample rather than applied when the report is computed, so the
 * claim is attached to the row it is about and can be disagreed with — a report
 * that filtered silently would be unfalsifiable.
 *
 * The reason is only ever set once. A sample that waited through an outage and
 * then a throttle is excluded for the first thing that went wrong, not the most
 * recent, because the first is what actually delayed it.
 */
export async function excludeSample(
  db: PilotExecutor,
  input: {
    readonly mappingId: string;
    readonly targetVersion: number;
    readonly reason: string;
  },
): Promise<void> {
  await db.execute(sql`
    update convergence_samples
       set excluded_reason = ${input.reason}
     where mapping_id = ${input.mappingId}::uuid
       and target_version = ${input.targetVersion}
       and excluded_reason is null
  `);
}

/**
 * How long a sample may stay pending before it stops being a live measurement.
 *
 * Twenty-four hours, matching section 12's dead-letter window. A change still
 * outstanding after a full day is not slow, it is broken, and the alerting tier
 * has said so long before this.
 */
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Closes samples that will never settle.
 *
 * A worker that dies between opening a sample and settling it leaves a row that
 * would otherwise sit in the pending count forever, making the outstanding
 * figure on the pilot screen grow without bound and meaning nothing.
 *
 * They are abandoned rather than deleted, and abandoned samples are reported as
 * misses. A change this installation accepted and never delivered is a failure
 * of the objective whatever went wrong, and quietly dropping it would let the
 * percentage improve every time something broke badly enough.
 */
export async function abandonStaleSamples(
  db: PilotExecutor,
  options: { readonly olderThan?: Date } = {},
): Promise<number> {
  const cutoff = options.olderThan ?? new Date(Date.now() - ABANDON_AFTER_MS);

  const rows = await db.execute<{ id: string }>(sql`
    update convergence_samples
       set outcome = 'abandoned'
     where outcome = 'pending'
       and computed_at < ${cutoff.toISOString()}::timestamptz
    returning id
  `);

  return rows.rows.length;
}
