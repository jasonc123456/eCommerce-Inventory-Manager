import { raiseAlert, type RaisedAlert } from '@eim/notifications';
import { type Database } from '@eim/db';
import { fileIncident } from '@eim/pilot';

/**
 * The synchronization core's alerts (sections 11, 12, 22).
 *
 * The lifecycle itself — deduplication, acknowledgement, snoozing, resolution,
 * escalation — lives in `@eim/notifications`, because it is the same lifecycle
 * for a stalled queue as for an oversold item and a second copy of it would
 * drift. What lives here is the part that is genuinely about synchronization:
 * which subject key each kind of problem deduplicates on, and how severe it is.
 *
 * That choice of subject key is the load-bearing decision in each function
 * below, so each one says why it is what it is.
 */

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
  const raised = await raiseAlert(db, {
    businessId: input.businessId,
    kind: 'oversold',
    severity: 'critical',
    subjectKey: `item:${input.canonicalItemId}`,
    canonicalItemId: input.canonicalItemId,
    summary: `an order could not be filled in full: ${String(input.shortage)} units short`,
    recommendedAction:
      'Check the item for stock that has not been counted, then adjust or cancel the affected order lines.',
    detail: { externalOrderId: input.externalOrderId, shortage: input.shortage },
  });

  // Section 1's first pilot criterion is "no oversale attributable to a
  // synchronization defect", and whether this one was is a judgement nobody can
  // make from here. So it is filed for review rather than counted, and the
  // criterion stays undemonstrated until a person says which kind it was.
  //
  // Filed against the alert id, which the unique index makes idempotent: an
  // unacknowledged oversell reminds every few hours, and a fresh incident per
  // reminder would turn the criterion into a measure of response time.
  await fileIncident(db, {
    businessId: input.businessId,
    kind: 'oversale',
    alertId: raised.alertId,
    summary: `${String(input.shortage)} units short on order ${input.externalOrderId}`,
  });

  return raised;
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
    recommendedAction: 'Open the mapping and clear the reason it is blocked, then retry the write.',
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
    recommendedAction: 'Deal with the cause, then replay the job from the dead-letter list.',
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
    recommendedAction: 'Open the conflict and choose which side of the disagreement is correct.',
  });
}
