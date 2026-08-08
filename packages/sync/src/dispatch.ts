import type { Database } from '@eim/db';
import { resolveWriteTarget } from '@eim/inventory';
import { JobPriority, enqueue, type ClaimedJob, type JobResult } from '@eim/jobs';
import type { ChannelAdapterFactory, ProviderFailure } from '@eim/providers';
import { describeFailure } from '@eim/providers';

import { alertMappingBlocked } from './alerts';
import { toJobFailure } from './failures';
import { sql } from 'drizzle-orm';

import {
  CHANNEL_WRITE_JOB,
  beginWriteAttempt,
  blockTarget,
  mappingSerializationKey,
  readTarget,
  recordObservation,
  settleWriteAttempt,
} from './targets';

/**
 * Carrying a desired quantity to a provider, and reading back what happened
 * (sections 12, 15).
 *
 * The order of the checks here is the whole design, and each one is a refusal
 * the milestone's exit gate depends on:
 *
 *   1. Is this job still carrying the newest target? If not it stands down
 *      without contacting anybody. Section 12: "superseded jobs are skipped."
 *   2. May this mapping be written to at all? Asked through `resolveWriteTarget`,
 *      the one function that answers it, and asked now rather than trusted from
 *      whenever the mapping was activated.
 *   3. Is the quantity already what we want it to be? Then say so and make no
 *      call. Section 15: "suppress no-op reads/writes."
 *
 * Only then does anything reach the network. A write that skipped any of the
 * three would be a write nobody asked for, at a channel that may not be ours to
 * write to, of a number that is already stale.
 */

export const CHANNEL_VERIFY_JOB = 'channel.verify';

export interface DispatchDependencies {
  /** Builds an adapter for one connection. Credentials are decrypted per use. */
  readonly adapterFor: ChannelAdapterFactory;
}

/**
 * Writes one mapping's current desired quantity.
 *
 * The job carries a version rather than a quantity. That is deliberate: by the
 * time a worker picks it up the number may have moved twice, and a job that
 * carried the figure would faithfully write something nobody wants any more.
 */
export async function handleChannelWrite(
  db: Database,
  job: ClaimedJob,
  deps: DispatchDependencies,
): Promise<JobResult> {
  const mappingId = asString(job.payload['mappingId']);
  const enqueuedVersion = asNumber(job.payload['targetVersion']);

  if (mappingId === null || job.businessId === null) {
    return {
      status: 'failed',
      failureKind: 'malformed_job',
      detail: 'this write job names no mapping',
      retryable: false,
    };
  }

  const target = await readTarget(db, mappingId);

  if (target === null) {
    return { status: 'superseded', detail: 'this mapping no longer has a desired target' };
  }

  if (enqueuedVersion !== null && enqueuedVersion < target.targetVersion) {
    // Section 12: an older target can never overwrite a newer committed one.
    return {
      status: 'superseded',
      detail: `version ${String(enqueuedVersion)} was overtaken by ${String(target.targetVersion)}`,
    };
  }

  if (target.state === 'blocked') {
    return {
      status: 'superseded',
      detail: target.stateReason ?? 'writing to this mapping is blocked',
    };
  }

  if (target.writtenVersion !== null && target.writtenVersion >= target.targetVersion) {
    return { status: 'superseded', detail: 'this target has already been written' };
  }

  const permitted = await resolveWriteTarget(db, {
    businessId: job.businessId,
    mappingId,
  });

  if (permitted.outcome !== 'writable') {
    // Not a failure of the job: the mapping is legitimately not writable, and
    // retrying will not change that until a human does something. The target
    // is blocked so the next ledger movement does not queue another one.
    await blockTarget(db, mappingId, whyNotWritable(permitted));
    await alertMappingBlocked(db, {
      businessId: job.businessId,
      mappingId,
      reason: whyNotWritable(permitted),
    });

    return { status: 'superseded', detail: whyNotWritable(permitted) };
  }

  const adapter = await deps.adapterFor(permitted.target.connectionId);
  const entity = { externalId: permitted.target.externalId };

  const attempt = await beginWriteAttempt(db, {
    businessId: job.businessId,
    mappingId,
    jobId: job.id,
    targetVersion: target.targetVersion,
    quantity: target.desiredQuantity,
  });

  const written = await adapter.writeQuantities([
    {
      entity,
      quantity: target.desiredQuantity,
      idempotencyKey: attempt.idempotencyKey,
      ...(target.observedVersion === null ? {} : { expectedVersion: target.observedVersion }),
    },
  ]);

  if (written.status !== 'success') {
    return failWrite(db, {
      attemptId: attempt.attemptId,
      mappingId,
      targetVersion: target.targetVersion,
      quantity: target.desiredQuantity,
      failure: written,
    });
  }

  const perEntity = written.value[0];

  if (perEntity === undefined) {
    return failWrite(db, {
      attemptId: attempt.attemptId,
      mappingId,
      targetVersion: target.targetVersion,
      quantity: target.desiredQuantity,
      failure: { status: 'unavailable', message: 'the provider acknowledged no entity' },
    });
  }

  if (perEntity.status !== 'success') {
    return failWrite(db, {
      attemptId: attempt.attemptId,
      mappingId,
      targetVersion: target.targetVersion,
      quantity: target.desiredQuantity,
      failure: perEntity,
    });
  }

  await settleWriteAttempt(db, {
    attemptId: attempt.attemptId,
    mappingId,
    targetVersion: target.targetVersion,
    quantity: target.desiredQuantity,
    settlement: {
      // Section 15 distinguishes these so a no-op is not counted as a
      // correction, which would make convergence reporting flatter than it is.
      outcome: perEntity.value.unchanged ? 'unchanged' : 'acknowledged',
      ...(perEntity.value.version === undefined
        ? {}
        : { observedVersion: perEntity.value.version }),
    },
  });

  // Section 15: "after an outbound channel write, schedule a targeted
  // verification read and compare it with the current versioned target."
  // Separately queued rather than done inline, because a provider that is slow
  // to make a write visible would otherwise hold the write job's lease open.
  await enqueue(db, {
    kind: CHANNEL_VERIFY_JOB,
    businessId: job.businessId,
    connectionId: permitted.target.connectionId,
    priority: JobPriority.verification,
    serializationKey: mappingSerializationKey(mappingId),
    payload: {
      mappingId,
      targetVersion: target.targetVersion,
      attemptId: attempt.attemptId,
    },
  });

  return { status: 'done' };
}

/**
 * Reads back what the provider actually holds after a write.
 *
 * Records the observation whatever it says. A verification that quietly agreed
 * with the write would be worth nothing; the value is entirely in it being able
 * to disagree, which is what turns a silent drift into evidence.
 */
export async function handleChannelVerify(
  db: Database,
  job: ClaimedJob,
  deps: DispatchDependencies,
): Promise<JobResult> {
  const mappingId = asString(job.payload['mappingId']);
  const attemptId = asString(job.payload['attemptId']);

  if (mappingId === null || job.businessId === null) {
    return {
      status: 'failed',
      failureKind: 'malformed_job',
      detail: 'this verification job names no mapping',
      retryable: false,
    };
  }

  const permitted = await resolveWriteTarget(db, { businessId: job.businessId, mappingId });

  if (permitted.outcome !== 'writable') {
    return { status: 'superseded', detail: whyNotWritable(permitted) };
  }

  const adapter = await deps.adapterFor(permitted.target.connectionId);
  const read = await adapter.readQuantities([{ externalId: permitted.target.externalId }]);

  if (read.status !== 'success') {
    return toJobFailure(read);
  }

  const observation = read.value[0];
  if (observation === undefined) {
    return {
      status: 'failed',
      failureKind: 'not_found',
      detail: 'the provider reported no quantity for this entity',
      retryable: false,
    };
  }

  await recordObservation(db, {
    mappingId,
    quantity: observation.quantity,
    ...(observation.version === undefined ? {} : { version: observation.version }),
    ...(observation.backordersEnabled === undefined
      ? {}
      : { backordersEnabled: observation.backordersEnabled }),
    ...(attemptId === null ? {} : { attemptId }),
  });

  const target = await readTarget(db, mappingId);

  if (target !== null && target.writtenQuantity !== null) {
    const agrees = observation.quantity === target.writtenQuantity;

    await db.execute(sql`
      update channel_targets
         set state = case
               when ${agrees} and target_version = written_version then 'converged'
               when ${agrees} then 'pending'
               else 'degraded'
             end,
             state_reason = ${
               agrees
                 ? null
                 : `the channel reports ${String(observation.quantity)} where ${String(target.writtenQuantity)} was written`
             }
       where mapping_id = ${mappingId}::uuid
    `);
  }

  return { status: 'done' };
}

/** Registers both handlers with a runner. */
export function dispatchHandlers(db: Database, deps: DispatchDependencies) {
  return {
    [CHANNEL_WRITE_JOB]: async (job: ClaimedJob) => handleChannelWrite(db, job, deps),
    [CHANNEL_VERIFY_JOB]: async (job: ClaimedJob) => handleChannelVerify(db, job, deps),
  };
}

async function failWrite(
  db: Database,
  input: {
    readonly attemptId: string;
    readonly mappingId: string;
    readonly targetVersion: number;
    readonly quantity: number;
    readonly failure: ProviderFailure;
  },
): Promise<JobResult> {
  await settleWriteAttempt(db, {
    attemptId: input.attemptId,
    mappingId: input.mappingId,
    targetVersion: input.targetVersion,
    quantity: input.quantity,
    settlement: {
      outcome: 'failed',
      failureKind: input.failure.status,
      detail: describeFailure(input.failure),
    },
  });

  if (input.failure.status === 'unauthorized' || input.failure.status === 'not_found') {
    // Both mean nothing will improve by trying again. Section 12 pauses on a
    // revoked credential and section 15 pauses a mapping whose entity is gone,
    // and in both cases continuing to queue writes would bury the alert under
    // failures that all say the same thing.
    await blockTarget(db, input.mappingId, describeFailure(input.failure));
  }

  return toJobFailure(input.failure);
}

function whyNotWritable(result: Awaited<ReturnType<typeof resolveWriteTarget>>): string {
  switch (result.outcome) {
    case 'writable':
      return '';
    case 'no_mapping':
      return 'this mapping no longer exists';
    case 'not_active':
      return result.reason ?? `this mapping is ${result.status}`;
    case 'ineligible':
      return result.reason;
    case 'missing':
      return 'the last complete catalog scan did not find this entity';
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
