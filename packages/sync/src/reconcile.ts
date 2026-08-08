import {
  channelMappings,
  inventoryConflicts,
  reconciliationFindings,
  reconciliationRuns,
  type ConflictKind,
  type Database,
  type ReconciliationFinding,
  type ReconciliationTrigger,
} from '@eim/db';
import { postMovements } from '@eim/inventory';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { alertConflict } from './alerts';
import type { DispatchDependencies } from './dispatch';
import { blockTarget, enqueueChannelWrite, readTarget, recordObservation } from './targets';

/**
 * Comparing what this ledger says with what a channel says (sections 12, 15).
 *
 * One rule decides everything below, and it is worth stating before the code:
 * a channel value that disagrees with ours is evidence, not a correction.
 * Reconciliation may push our figure out to a channel. It may never pull a
 * channel figure into physical inventory — that is a decision about the real
 * world, and only a person who has looked at a shelf can take it.
 *
 * Which gives three outcomes for a disagreement, and section 15 names all of
 * them:
 *
 *   The channel is behind because our own write has not landed yet. That is
 *   explainable and repairable automatically: re-send the target.
 *
 *   The channel says more than we would ever have written. That is unexplained,
 *   and it is also the dangerous direction — the channel is offering stock that
 *   may not exist — so the mapping is paused, a protective write is queued to
 *   bring it down, and a conflict is opened.
 *
 *   The channel says less than we would have written. Also unexplained, but
 *   safe: nothing is being oversold. The mapping is paused and a conflict is
 *   opened, and the quantity is deliberately left alone. Section 15: "if the
 *   observed channel quantity is already lower than the safe target, leave it
 *   unchanged while the mapping is paused."
 */

export interface ReconcileInput {
  readonly businessId: string;
  readonly connectionId?: string;
  readonly mappingIds?: readonly string[];
  readonly trigger: ReconciliationTrigger;
  /** A dry run proposes and records; it changes nothing. */
  readonly dryRun?: boolean;
  readonly requestedByUserId?: string | null;
}

export interface FindingSummary {
  readonly mappingId: string;
  readonly finding: ReconciliationFinding;
  readonly canonicalQuantity: number;
  readonly observedQuantity: number | null;
  readonly proposedAction: 'none' | 'write' | 'conflict';
  readonly detail: string | null;
}

export interface ReconcileResult {
  readonly runId: string;
  readonly examined: number;
  readonly matched: number;
  readonly discrepancies: number;
  readonly repaired: number;
  readonly conflictsOpened: number;
  readonly findings: readonly FindingSummary[];
}

/**
 * Examines a set of mappings and records what it found.
 *
 * A dry run and an applied run take exactly the same path and reach exactly the
 * same conclusions; the only difference is whether the proposed action is
 * carried out. That is deliberate — section 15 requires a dry run to show
 * "proposed writes, conflicts, unsupported entities", and a preview computed by
 * different code than the repair is a preview that can be wrong.
 */
export async function reconcile(
  db: Database,
  input: ReconcileInput,
  deps: DispatchDependencies,
): Promise<ReconcileResult> {
  const dryRun = input.dryRun ?? true;

  const [run] = await db
    .insert(reconciliationRuns)
    .values({
      businessId: input.businessId,
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      scope: input.mappingIds === undefined ? 'business' : 'mapping',
      trigger: input.trigger,
      dryRun,
      ...(input.requestedByUserId == null ? {} : { requestedByUserId: input.requestedByUserId }),
    })
    .returning({ id: reconciliationRuns.id });

  if (run === undefined) {
    throw new Error('opening a reconciliation run returned nothing');
  }

  const runId = run.id;
  const mappings = await mappingsInScope(db, input);
  const findings: FindingSummary[] = [];

  const tally = {
    examined: 0,
    matched: 0,
    discrepancies: 0,
    repaired: 0,
    conflictsOpened: 0,
    skipped: 0,
    failedCalls: 0,
  };

  for (const mapping of mappings) {
    tally.examined += 1;

    const summary = await examineMapping(db, {
      runId,
      businessId: input.businessId,
      mappingId: mapping.mappingId,
      connectionId: mapping.connectionId,
      externalId: mapping.externalId,
      dryRun,
      deps,
    });

    findings.push(summary);

    switch (summary.finding) {
      case 'match':
        tally.matched += 1;
        break;
      case 'unsupported':
        tally.skipped += 1;
        break;
      case 'unreachable':
        tally.failedCalls += 1;
        break;
      case 'stale_write':
        tally.discrepancies += 1;
        if (!dryRun) {
          tally.repaired += 1;
        }
        break;
      case 'drift':
        tally.discrepancies += 1;
        if (!dryRun) {
          tally.conflictsOpened += 1;
        }
        break;
    }
  }

  await db
    .update(reconciliationRuns)
    .set({ status: 'completed', finishedAt: new Date(), ...tally })
    .where(eq(reconciliationRuns.id, runId));

  return {
    runId,
    examined: tally.examined,
    matched: tally.matched,
    discrepancies: tally.discrepancies,
    repaired: tally.repaired,
    conflictsOpened: tally.conflictsOpened,
    findings,
  };
}

async function examineMapping(
  db: Database,
  input: {
    readonly runId: string;
    readonly businessId: string;
    readonly mappingId: string;
    readonly connectionId: string;
    readonly externalId: string;
    readonly dryRun: boolean;
    readonly deps: DispatchDependencies;
  },
): Promise<FindingSummary> {
  const target = await readTarget(db, input.mappingId);

  if (target === null) {
    return record(db, input, {
      finding: 'unsupported',
      canonicalQuantity: 0,
      observedQuantity: null,
      canonicalVersion: 0,
      proposedAction: 'none',
      detail: 'this mapping has no desired target yet',
    });
  }

  const adapter = await input.deps.adapterFor(input.connectionId);
  const read = await adapter.readQuantities([{ externalId: input.externalId }]);

  if (read.status !== 'success') {
    return record(db, input, {
      finding: 'unreachable',
      canonicalQuantity: target.desiredQuantity,
      observedQuantity: null,
      canonicalVersion: target.targetVersion,
      proposedAction: 'none',
      detail: `the provider could not be asked: ${read.status}`,
    });
  }

  const observation = read.value[0];

  if (observation === undefined) {
    return record(db, input, {
      finding: 'unsupported',
      canonicalQuantity: target.desiredQuantity,
      observedQuantity: null,
      canonicalVersion: target.targetVersion,
      proposedAction: 'none',
      detail: 'the provider reports no quantity for this entity',
    });
  }

  // Recorded whatever it says, and before any conclusion is drawn from it. The
  // observation is evidence in its own right, and a run that decided nothing
  // still leaves behind what the channel said at that moment.
  await recordObservation(db, {
    mappingId: input.mappingId,
    quantity: observation.quantity,
    ...(observation.version === undefined ? {} : { version: observation.version }),
    ...(observation.backordersEnabled === undefined
      ? {}
      : { backordersEnabled: observation.backordersEnabled }),
  });

  if (observation.quantity === target.desiredQuantity) {
    return record(db, input, {
      finding: 'match',
      canonicalQuantity: target.desiredQuantity,
      observedQuantity: observation.quantity,
      canonicalVersion: target.targetVersion,
      proposedAction: 'none',
      detail: null,
      ...(observation.version === undefined ? {} : { observedVersion: observation.version }),
    });
  }

  // Explainable: the channel is showing what we last wrote, and a newer target
  // simply has not been sent yet. Section 15 repairs these automatically.
  const explainable =
    target.writtenQuantity !== null && observation.quantity === target.writtenQuantity;

  if (explainable) {
    if (!input.dryRun) {
      await enqueueChannelWrite(db, {
        businessId: input.businessId,
        connectionId: input.connectionId,
        mappingId: input.mappingId,
        targetVersion: target.targetVersion,
        protective: target.desiredQuantity < observation.quantity,
      });
    }

    return record(db, input, {
      finding: 'stale_write',
      canonicalQuantity: target.desiredQuantity,
      observedQuantity: observation.quantity,
      canonicalVersion: target.targetVersion,
      proposedAction: 'write',
      detail: 'the channel is showing our previous write; the newest target has not been sent',
      ...(observation.version === undefined ? {} : { observedVersion: observation.version }),
    });
  }

  const overstating = observation.quantity > target.desiredQuantity;

  if (!input.dryRun) {
    const summary = `the channel reports ${String(observation.quantity)} where ${String(target.desiredQuantity)} was expected`;

    const conflictId = await openConflict(db, {
      businessId: input.businessId,
      mappingId: input.mappingId,
      connectionId: input.connectionId,
      runId: input.runId,
      kind: 'quantity_drift',
      expectedQuantity: target.desiredQuantity,
      observedQuantity: observation.quantity,
      summary,
    });

    if (conflictId !== null) {
      // Only for a conflict that is actually new. A drift re-detected every
      // thirty minutes has already been reported, and repeating it is how the
      // one that matters becomes unfindable.
      await alertConflict(db, {
        businessId: input.businessId,
        conflictId,
        mappingId: input.mappingId,
        summary,
      });
    }

    await blockTarget(
      db,
      input.mappingId,
      'an unexplained channel quantity is under investigation',
    );

    if (overstating) {
      // Section 15: "if the observed channel quantity exceeds the safe canonical
      // target, attempt a protective reduction to the target while keeping the
      // conflict open." The channel is offering stock that may not exist, and
      // that is worth correcting before anybody agrees on why.
      await db.execute(sql`
        update channel_targets set state = 'pending' where mapping_id = ${input.mappingId}::uuid
      `);
      await enqueueChannelWrite(db, {
        businessId: input.businessId,
        connectionId: input.connectionId,
        mappingId: input.mappingId,
        targetVersion: target.targetVersion,
        protective: true,
      });
    }
  }

  return record(db, input, {
    finding: 'drift',
    canonicalQuantity: target.desiredQuantity,
    observedQuantity: observation.quantity,
    canonicalVersion: target.targetVersion,
    proposedAction: 'conflict',
    detail: overstating
      ? 'the channel is offering more than this ledger accounts for'
      : 'the channel is offering less than this ledger accounts for; left unchanged while paused',
    ...(observation.version === undefined ? {} : { observedVersion: observation.version }),
  });
}

async function record(
  db: Database,
  input: { readonly runId: string; readonly businessId: string; readonly mappingId: string },
  finding: {
    readonly finding: ReconciliationFinding;
    readonly canonicalQuantity: number;
    readonly observedQuantity: number | null;
    readonly canonicalVersion: number;
    readonly observedVersion?: string;
    readonly proposedAction: 'none' | 'write' | 'conflict';
    readonly detail: string | null;
  },
): Promise<FindingSummary> {
  await db.insert(reconciliationFindings).values({
    runId: input.runId,
    businessId: input.businessId,
    mappingId: input.mappingId,
    canonicalVersion: finding.canonicalVersion,
    canonicalQuantity: finding.canonicalQuantity,
    observedQuantity: finding.observedQuantity,
    finding: finding.finding,
    proposedAction: finding.proposedAction,
    detail: finding.detail,
    ...(finding.observedVersion === undefined ? {} : { observedVersion: finding.observedVersion }),
  });

  return {
    mappingId: input.mappingId,
    finding: finding.finding,
    canonicalQuantity: finding.canonicalQuantity,
    observedQuantity: finding.observedQuantity,
    proposedAction: finding.proposedAction,
    detail: finding.detail,
  };
}

/**
 * Opens a conflict, or leaves the existing one alone.
 *
 * A drift re-detected every thirty minutes must not produce a queue of
 * identical decisions for one person to work through. The partial unique index
 * enforces that; `on conflict do nothing` is how this function cooperates with
 * it rather than fighting it.
 */
export async function openConflict(
  db: Database,
  input: {
    readonly businessId: string;
    readonly mappingId?: string;
    readonly canonicalItemId?: string;
    readonly connectionId?: string;
    readonly runId?: string;
    readonly kind: ConflictKind;
    readonly severity?: 'low' | 'medium' | 'high' | 'critical';
    readonly expectedQuantity?: number;
    readonly observedQuantity?: number;
    readonly summary: string;
  },
): Promise<string | null> {
  const rows = await db
    .insert(inventoryConflicts)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      severity: input.severity ?? 'high',
      summary: input.summary,
      ...(input.mappingId === undefined ? {} : { mappingId: input.mappingId }),
      ...(input.canonicalItemId === undefined ? {} : { canonicalItemId: input.canonicalItemId }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.expectedQuantity === undefined ? {} : { expectedQuantity: input.expectedQuantity }),
      ...(input.observedQuantity === undefined ? {} : { observedQuantity: input.observedQuantity }),
    })
    .onConflictDoNothing()
    .returning({ id: inventoryConflicts.id });

  return rows[0]?.id ?? null;
}

export type ResolveConflictResult =
  | { readonly outcome: 'resolved' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'already_resolved' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Closes a conflict the way an authorized person decided to close it.
 *
 * Every path states what was believed and why. There is no "dismiss": section
 * 12 says an unresolved mismatch cannot be dismissed, and the database check
 * behind this function refuses a resolved row that names no resolution and no
 * reason — so the rule holds even for a caller that forgets it.
 *
 * `adopt_external` is the only resolution that changes physical stock, and it
 * does so through an ordinary ledger adjustment. That keeps section 8's rule
 * intact: stock never moves without an entry explaining it, and "an authorized
 * person accepted the channel's count on this date" is exactly the explanation
 * somebody will want six weeks later.
 */
export async function resolveConflict(
  db: Database,
  input: {
    readonly businessId: string;
    readonly conflictId: string;
    readonly resolution:
      | 'adopt_external'
      | 'overwrite_channel'
      | 'audited_quantity'
      | 'remap'
      | 'shortage_disposition'
      | 'repaired';
    readonly reason: string;
    readonly actorUserId: string;
    /** Required for `adopt_external` and `audited_quantity`. */
    readonly locationId?: string;
    readonly quantityDelta?: number;
  },
): Promise<ResolveConflictResult> {
  if (input.reason.trim().length === 0) {
    return { outcome: 'invalid', reason: 'resolving a conflict needs a stated reason' };
  }

  const [conflict] = await db
    .select()
    .from(inventoryConflicts)
    .where(
      and(
        eq(inventoryConflicts.businessId, input.businessId),
        eq(inventoryConflicts.id, input.conflictId),
      ),
    )
    .limit(1);

  if (conflict === undefined) {
    return { outcome: 'not_found' };
  }
  if (conflict.status === 'resolved') {
    return { outcome: 'already_resolved' };
  }

  let ledgerEntryId: string | null = null;
  const changesStock =
    input.resolution === 'adopt_external' || input.resolution === 'audited_quantity';

  if (changesStock) {
    if (input.locationId === undefined || input.quantityDelta === undefined) {
      return {
        outcome: 'invalid',
        reason: 'adopting a quantity needs both a location and how much to move',
      };
    }
    if (conflict.canonicalItemId === null) {
      return {
        outcome: 'invalid',
        reason: 'this conflict names no canonical item, so there is nothing to adjust',
      };
    }

    if (input.quantityDelta !== 0) {
      const posted = await postMovements(db, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        movements: [
          {
            canonicalItemId: conflict.canonicalItemId,
            locationId: input.locationId,
            kind: 'reconciliation',
            quantityDelta: input.quantityDelta,
            reason: input.reason,
          },
        ],
      });

      if (posted.outcome !== 'posted') {
        return { outcome: 'invalid', reason: 'the adjustment this resolution needs was refused' };
      }

      ledgerEntryId = posted.entryIds[0] ?? null;
    }
  }

  await db
    .update(inventoryConflicts)
    .set({
      status: 'resolved',
      resolution: input.resolution,
      resolutionReason: input.reason,
      resolvedByUserId: input.actorUserId,
      resolvedAt: new Date(),
      ...(ledgerEntryId === null ? {} : { ledgerEntryId }),
    })
    .where(eq(inventoryConflicts.id, input.conflictId));

  // Whatever was decided, the mapping stops being under investigation. The
  // target goes back to pending rather than converged: whether the channel now
  // agrees is a question for the next write and its verification, not something
  // to assert on the strength of a form submission.
  if (conflict.mappingId !== null) {
    await db.execute(sql`
      update channel_targets
         set state = 'pending', state_reason = null
       where mapping_id = ${conflict.mappingId}::uuid
    `);
  }

  return { outcome: 'resolved' };
}

async function mappingsInScope(
  db: Database,
  input: ReconcileInput,
): Promise<
  readonly {
    readonly mappingId: string;
    readonly connectionId: string;
    readonly externalId: string;
  }[]
> {
  const conditions = [
    eq(channelMappings.businessId, input.businessId),
    // Only active mappings. Section 15 reconciles "every active mapped inventory
    // unit"; a draft or archived mapping has nothing to be out of step with.
    eq(channelMappings.status, 'active'),
  ];

  if (input.connectionId !== undefined) {
    conditions.push(eq(channelMappings.connectionId, input.connectionId));
  }
  if (input.mappingIds !== undefined) {
    conditions.push(inArray(channelMappings.id, [...input.mappingIds]));
  }

  const rows = await db.execute<{
    mapping_id: string;
    connection_id: string;
    external_id: string;
  }>(sql`
    select m.id as mapping_id, m.connection_id, p.external_id
      from channel_mappings m
      join provider_items p on p.id = m.provider_item_id
     where m.business_id = ${input.businessId}::uuid
       and m.status = 'active'
       ${input.connectionId === undefined ? sql`` : sql`and m.connection_id = ${input.connectionId}::uuid`}
       ${
         input.mappingIds === undefined
           ? sql``
           : sql`and m.id = any(${sql.param([...input.mappingIds])}::uuid[])`
       }
     order by m.id
  `);

  return rows.rows.map((row) => ({
    mappingId: row.mapping_id,
    connectionId: row.connection_id,
    externalId: row.external_id,
  }));
}
