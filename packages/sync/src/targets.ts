import type { Database } from '@eim/db';
import { projectItem } from '@eim/inventory';
import { JobPriority, enqueue, type QueueExecutor } from '@eim/jobs';
import { sql } from 'drizzle-orm';

/**
 * What each channel should be advertising, and how a change reaches it
 * (sections 8, 12, 15).
 *
 * The rule this module exists to enforce is section 12's: "older targets can
 * never overwrite newer committed targets". It is enforced twice, deliberately.
 * Once here, by a version that only ever increases and a job that stands down
 * when it is not carrying the newest one; and once in the database, by a check
 * constraint that makes a written version ahead of a desired version unstorable.
 * The first is what normally happens; the second is what catches the case
 * nobody thought of.
 *
 * Targets are recorded in the same transaction as the ledger movement that
 * caused them. That is the whole point of the queue living in PostgreSQL: a
 * sale, its ledger entries, its new balances, and the intent to tell two
 * channels about all of it either all happen or none of them do.
 */

export const CHANNEL_WRITE_JOB = 'channel.write';

/** One job at a time per mapping. Section 12: "writes serialize per channel mapping." */
export function mappingSerializationKey(mappingId: string): string {
  return `mapping:${mappingId}`;
}

export interface DesiredTargetInput {
  readonly businessId: string;
  readonly mappingId: string;
  readonly connectionId: string;
  readonly quantity: number;
  readonly reason: string;
}

export interface DesiredTargetResult {
  readonly targetVersion: number;
  readonly quantity: number;
  /**
   * False when the desired quantity was already this and already written.
   * Section 15 asks for unchanged writes to be suppressed, and this is where
   * that decision is taken — not in the worker, which would have to make a
   * provider call to discover it.
   */
  readonly changed: boolean;
}

/**
 * Records what a mapping should now advertise.
 *
 * The version bump and the quantity land in one statement, so two concurrent
 * callers cannot both read version 4 and both write version 5. Whichever
 * commits second sees the other's version and goes to 6, which is exactly the
 * monotonicity the write path depends on.
 */
export async function recordDesiredTarget(
  db: QueueExecutor,
  input: DesiredTargetInput,
): Promise<DesiredTargetResult> {
  const rows = await db.execute<{
    target_version: string | number;
    desired_quantity: number;
    changed: boolean;
  }>(sql`
    insert into channel_targets (business_id, mapping_id, desired_quantity, reason, state)
    values (${input.businessId}::uuid, ${input.mappingId}::uuid, ${input.quantity},
            ${input.reason}, 'pending')
    on conflict (mapping_id) do update
       set desired_quantity = excluded.desired_quantity,
           reason           = excluded.reason,
           computed_at      = now(),
           -- Only a real change advances the version. Re-recording a quantity
           -- that is already the target must leave the version alone, or every
           -- reconciliation pass would invalidate the write already in flight
           -- and the mapping could never converge.
           target_version = channel_targets.target_version + (
             case when channel_targets.desired_quantity is distinct from excluded.desired_quantity
                  then 1 else 0 end
           ),
           state = case
             when channel_targets.desired_quantity is distinct from excluded.desired_quantity
               then 'pending'
             else channel_targets.state
           end
    -- "Needs a write" rather than "was modified": a target recorded twice with
    -- the same quantity still needs sending if the first attempt never landed.
    returning target_version,
              desired_quantity,
              (target_version > coalesce(written_version, -1)) as changed
  `);

  const row = rows.rows[0];
  if (row === undefined) {
    throw new Error('recording a desired channel target returned nothing');
  }

  return {
    targetVersion: Number(row.target_version),
    quantity: row.desired_quantity,
    changed: row.changed,
  };
}

/**
 * Queues the provider call that carries a target to its channel.
 *
 * The version travels on the job. A worker that picks it up later compares it
 * with the row and stands down if a newer target has been recorded since —
 * section 12's "superseded jobs are skipped" — rather than writing a quantity
 * that was correct when it was queued and is wrong now.
 *
 * Reductions outrank increases. Section 15: "prioritize protective reductions
 * over increases when capacity or provider health is constrained." Advertising
 * more than exists is an oversell; advertising less is a missed sale, and only
 * one of those has to be apologized for.
 */
export async function enqueueChannelWrite(
  db: QueueExecutor,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly mappingId: string;
    readonly targetVersion: number;
    readonly protective: boolean;
  },
): Promise<void> {
  await enqueue(db, {
    kind: CHANNEL_WRITE_JOB,
    businessId: input.businessId,
    connectionId: input.connectionId,
    priority: input.protective ? JobPriority.protectiveWrite : JobPriority.inventoryWrite,
    serializationKey: mappingSerializationKey(input.mappingId),
    payload: { mappingId: input.mappingId, targetVersion: input.targetVersion },
  });
}

export interface TargetRow {
  readonly businessId: string;
  readonly mappingId: string;
  readonly targetVersion: number;
  readonly desiredQuantity: number;
  readonly writtenVersion: number | null;
  readonly writtenQuantity: number | null;
  readonly observedQuantity: number | null;
  readonly observedVersion: string | null;
  readonly observedBackorders: boolean | null;
  readonly state: 'pending' | 'converged' | 'degraded' | 'blocked';
  readonly stateReason: string | null;
  readonly consecutiveFailures: number;
}

export async function readTarget(db: QueueExecutor, mappingId: string): Promise<TargetRow | null> {
  const rows = await db.execute<TargetRowShape>(sql`
    select business_id, mapping_id, target_version, desired_quantity,
           written_version, written_quantity, observed_quantity, observed_version,
           observed_backorders, state, state_reason, consecutive_failures
      from channel_targets
     where mapping_id = ${mappingId}::uuid
  `);

  const row = rows.rows[0];

  return row === undefined ? null : toTarget(row);
}

/**
 * Recomputes every channel target for one canonical item and queues the writes.
 *
 * This is the bridge from the ledger to the outbox, and the only one: nothing
 * else decides what a channel should say. It reuses `projectItem` rather than
 * recomputing, so the number an operator was shown in a dry run and the number
 * a provider is eventually told are produced by the same code. A second
 * implementation here would be correct for exactly as long as it took either
 * side of section 8 to change.
 *
 * Call it inside the transaction that moved the stock.
 */
export async function refreshTargetsForItem(
  db: Database,
  input: {
    readonly businessId: string;
    readonly canonicalItemId: string;
    readonly reason: string;
  },
): Promise<readonly DesiredTargetResult[]> {
  const projection = await projectItem(db, {
    businessId: input.businessId,
    canonicalItemId: input.canonicalItemId,
  });

  if (projection === null) {
    return [];
  }

  const results: DesiredTargetResult[] = [];

  for (const channel of projection.channels) {
    if (!channel.writable) {
      // Section 15: an ineligible or paused mapping does not stop the others,
      // and it does not accumulate targets it will never be allowed to send.
      continue;
    }

    if (channel.suppressed) {
      // Section 8 as amended by D-130: a backorder-enabled WooCommerce product
      // showing negative stock is recording demand, and writing zero over it
      // would erase what the store owes its customers.
      continue;
    }

    const target = await recordDesiredTarget(db, {
      businessId: input.businessId,
      mappingId: channel.mappingId,
      connectionId: channel.connectionId,
      quantity: channel.currentTarget,
      reason: input.reason,
    });

    results.push(target);

    if (target.changed) {
      await enqueueChannelWrite(db, {
        businessId: input.businessId,
        connectionId: channel.connectionId,
        mappingId: channel.mappingId,
        targetVersion: target.targetVersion,
        protective:
          channel.channelQuantity !== null && channel.currentTarget < channel.channelQuantity,
      });
    }
  }

  return results;
}

/** Opens the record of a provider call, before it is made. */
export async function beginWriteAttempt(
  db: QueueExecutor,
  input: {
    readonly businessId: string;
    readonly mappingId: string;
    readonly jobId: string;
    readonly targetVersion: number;
    readonly quantity: number;
  },
): Promise<{ readonly attemptId: string; readonly idempotencyKey: string }> {
  // Derived from the mapping and the version rather than randomly generated, so
  // a retry after an ambiguous timeout sends the provider the same key and the
  // provider can recognize it. A fresh key per attempt would make every retry a
  // new write in the provider's eyes, which is exactly what section 12's
  // idempotency requirement exists to prevent.
  const idempotencyKey = `${input.mappingId}:${String(input.targetVersion)}`;

  const rows = await db.execute<{ id: string }>(sql`
    insert into channel_write_attempts
      (business_id, mapping_id, job_id, target_version, quantity, idempotency_key, outcome)
    values (${input.businessId}::uuid, ${input.mappingId}::uuid, ${input.jobId}::uuid,
            ${input.targetVersion}, ${input.quantity}, ${idempotencyKey}, 'sent')
    on conflict (mapping_id, idempotency_key) do update
       set started_at = now(), outcome = 'sent', finished_at = null
    returning id
  `);

  const id = rows.rows[0]?.id;
  if (id === undefined) {
    throw new Error('opening a channel write attempt returned nothing');
  }

  return { attemptId: id, idempotencyKey };
}

export type WriteSettlement =
  | { readonly outcome: 'acknowledged' | 'unchanged'; readonly observedVersion?: string }
  | {
      readonly outcome: 'failed';
      readonly failureKind: string;
      readonly detail: string;
    }
  | { readonly outcome: 'superseded'; readonly detail: string };

/**
 * Records what the provider did, and moves the target's state accordingly.
 *
 * The written version is only advanced on a success, and the check constraint
 * refuses to store one ahead of the desired version. Together those mean a
 * late-arriving acknowledgement for an old version cannot make a mapping look
 * converged when it is not.
 */
export async function settleWriteAttempt(
  db: QueueExecutor,
  input: {
    readonly attemptId: string;
    readonly mappingId: string;
    readonly targetVersion: number;
    readonly quantity: number;
    readonly settlement: WriteSettlement;
  },
): Promise<void> {
  const settlement = input.settlement;
  const failureKind = settlement.outcome === 'failed' ? settlement.failureKind : null;
  const detail =
    settlement.outcome === 'failed' || settlement.outcome === 'superseded'
      ? settlement.detail
      : null;

  await db.execute(sql`
    update channel_write_attempts
       set outcome = ${settlement.outcome},
           failure_kind = ${failureKind},
           detail = ${detail},
           finished_at = now()
     where id = ${input.attemptId}::uuid
  `);

  if (settlement.outcome === 'superseded') {
    return;
  }

  if (settlement.outcome === 'failed') {
    await db.execute(sql`
      update channel_targets
         set state = 'degraded',
             state_reason = ${settlement.detail},
             consecutive_failures = consecutive_failures + 1
       where mapping_id = ${input.mappingId}::uuid
    `);

    return;
  }

  await db.execute(sql`
    update channel_targets
       set written_version = ${input.targetVersion},
           written_quantity = ${input.quantity},
           written_at = now(),
           observed_version = coalesce(${settlement.observedVersion ?? null}, observed_version),
           consecutive_failures = 0,
           -- Converged only if nothing newer has been recorded meanwhile. A
           -- write that lands after the ledger moved again is a success for the
           -- version it carried and still leaves the mapping behind.
           state = case when target_version = ${input.targetVersion} then 'converged' else 'pending' end,
           state_reason = null
     where mapping_id = ${input.mappingId}::uuid
       and coalesce(written_version, -1) < ${input.targetVersion}
  `);
}

/**
 * Records what the provider says it currently holds.
 *
 * Never a correction. Section 15 is explicit that channel state is evidence,
 * not truth: an observation that disagrees with the written quantity is the
 * input to reconciliation, and adopting it here would let an unexplained
 * external edit rewrite canonical inventory with nobody deciding to.
 */
export async function recordObservation(
  db: QueueExecutor,
  input: {
    readonly mappingId: string;
    readonly quantity: number;
    readonly version?: string;
    readonly backordersEnabled?: boolean;
    readonly attemptId?: string;
  },
): Promise<void> {
  await db.execute(sql`
    update channel_targets
       set observed_quantity = ${input.quantity},
           observed_at = now(),
           observed_version = coalesce(${input.version ?? null}, observed_version),
           observed_backorders = coalesce(${input.backordersEnabled ?? null}, observed_backorders)
     where mapping_id = ${input.mappingId}::uuid
  `);

  if (input.attemptId !== undefined) {
    await db.execute(sql`
      update channel_write_attempts
         set verified_quantity = ${input.quantity}, verified_at = now()
       where id = ${input.attemptId}::uuid
    `);
  }
}

/** Stops writing to a mapping until somebody resolves why. */
export async function blockTarget(
  db: QueueExecutor,
  mappingId: string,
  reason: string,
): Promise<void> {
  await db.execute(sql`
    update channel_targets
       set state = 'blocked', state_reason = ${reason}
     where mapping_id = ${mappingId}::uuid
  `);
}

interface TargetRowShape extends Record<string, unknown> {
  business_id: string;
  mapping_id: string;
  target_version: string | number;
  desired_quantity: number;
  written_version: string | number | null;
  written_quantity: number | null;
  observed_quantity: number | null;
  observed_version: string | null;
  observed_backorders: boolean | null;
  state: TargetRow['state'];
  state_reason: string | null;
  consecutive_failures: number;
}

function toTarget(row: TargetRowShape): TargetRow {
  return {
    businessId: row.business_id,
    mappingId: row.mapping_id,
    targetVersion: Number(row.target_version),
    desiredQuantity: row.desired_quantity,
    writtenVersion: row.written_version === null ? null : Number(row.written_version),
    writtenQuantity: row.written_quantity,
    observedQuantity: row.observed_quantity,
    observedVersion: row.observed_version,
    observedBackorders: row.observed_backorders,
    state: row.state,
    stateReason: row.state_reason,
    consecutiveFailures: row.consecutive_failures,
  };
}
