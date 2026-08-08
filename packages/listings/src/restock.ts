import type { AuditRecorder } from '@eim/audit';
import type { Database } from '@eim/db';
import {
  describeFailure,
  isSuccess,
  type ChannelAdapter,
  type ChannelEntityRef,
} from '@eim/providers';

import type { FingerprintValue } from './fingerprint';
import {
  assessRestockEligibility,
  mayRestock,
  type RestockEligibility,
  type RestockSubject,
} from './restock-eligibility';
import {
  beginExecution,
  completeExecution,
  failExecution,
  proposeOperation,
  type ProposedOperation,
} from './review';

/**
 * Putting an eligible listing back on sale (sections 6, 7, 13, 30).
 *
 * This is the one milestone-5 operation that is not really about listing
 * content, and it is here rather than in the synchronization core for a reason
 * worth stating. Writing a quantity to a live listing is routine and automatic;
 * taking a listing that customers currently cannot see and making it visible
 * again is a change to what the public can buy. Section 6 grants it with the
 * word "confirmed" in the sentence — "confirmed positive stock can return
 * eligible listing to sale" — so it carries a publication permission, a
 * person's agreement to a specific quantity, and the shortest freshness window
 * of any operation here.
 *
 * That window is five minutes because stock is the most volatile thing this
 * application holds. A confirmation against a figure read half an hour ago is a
 * confirmation of a quantity that may already be somebody else's order.
 */

export class RestockRefused extends Error {
  public readonly verdict: string;

  constructor(message: string, verdict: string) {
    super(message);
    this.name = 'RestockRefused';
    this.verdict = verdict;
  }
}

export interface ProposeRestockInput {
  readonly businessId: string;
  readonly mappingId: string;
  readonly canonicalItemId: string;
  readonly connectionId: string;
  readonly entity: ChannelEntityRef;
  readonly adapter: ChannelAdapter;
  /** What the ledger says can be sold through this mapping right now. */
  readonly availableToSell: number;
  readonly mappingStatus: RestockSubject['mappingStatus'];
  readonly actorUserId: string;
  readonly now?: Date;
}

export interface ProposedRestock extends ProposedOperation {
  readonly eligibility: RestockEligibility;
  readonly quantity: number;
}

/**
 * Reads the listing's state, checks section 6's rules, and records a proposal.
 *
 * The provider is asked what the listing is before anything else, because the
 * distinction between hidden and ended is the whole rule and nothing on this
 * side of the boundary can tell them apart.
 */
export async function proposeRestockToLive(
  db: Database,
  audit: AuditRecorder,
  input: ProposeRestockInput,
): Promise<ProposedRestock> {
  const observedAt = input.now ?? new Date();
  const observation = await input.adapter.listingOperations?.readListingState?.(input.entity);

  if (observation === undefined) {
    throw new RestockRefused('this channel has no notion of a hidden listing', 'unsupported');
  }
  if (!isSuccess(observation)) {
    throw new RestockRefused(describeFailure(observation), 'provider');
  }

  const eligibility = assessRestockEligibility({
    listingState: observation.value.state,
    outOfStockControlEnabled: observation.value.outOfStockControlEnabled,
    availableToSell: input.availableToSell,
    mappingStatus: input.mappingStatus,
  });

  if (!mayRestock(eligibility) || eligibility.quantity === undefined) {
    throw new RestockRefused(eligibility.reason, eligibility.verdict);
  }

  const quantity = eligibility.quantity;

  const decisive: FingerprintValue = {
    entity: input.entity.externalId,
    variation: input.entity.variationId ?? null,
    quantity,
    // The listing's own version is inside the agreement, so a listing that has
    // moved on the channel since the screen was drawn cannot be restocked
    // against a state nobody looked at.
    listingVersion: observation.value.version ?? null,
    listingState: observation.value.state,
  };

  const proposal = await proposeOperation(db, {
    businessId: input.businessId,
    kind: 'restock_to_live',
    subjectKey: `mapping:${input.mappingId}`,
    // Publication rather than an inventory permission: this changes what the
    // public can buy, not what a number says.
    requiredPermission: 'publish_listings',
    preview: {
      entity: input.entity,
      quantity,
      listingState: observation.value.state,
      listingVersion: observation.value.version,
      eligibility: { verdict: eligibility.verdict, reason: eligibility.reason },
      warnings: [
        'this returns the listing to sale immediately; it will be hidden again if availability reaches zero',
      ],
    },
    decisive,
    sourceObservedAt: observedAt,
    proposedByUserId: input.actorUserId,
    idempotencyKey: `restock:${input.businessId}:${input.mappingId}:${String(observedAt.getTime())}`,
    mappingId: input.mappingId,
    canonicalItemId: input.canonicalItemId,
    destinationConnectionId: input.connectionId,
    externalReference: input.entity.externalId,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  await audit.record(db, {
    action: 'listing.operation.proposed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: proposal.operationId,
    detail: { kind: 'restock_to_live', quantity, externalId: input.entity.externalId },
  });

  return { ...proposal, eligibility, quantity };
}

export interface ExecuteRestockInput {
  readonly businessId: string;
  readonly operationId: string;
  readonly adapter: ChannelAdapter;
}

export interface AppliedRestock {
  readonly quantity: number;
  readonly state: string;
}

/**
 * Returns the listing to sale at the confirmed quantity.
 *
 * The listing version observed at proposal time is sent as the expected
 * version, so a listing somebody else changed in the meantime produces a
 * conflict rather than an overwrite. That is the same rule the automatic write
 * path follows, and it matters more here: the quantity being written is one a
 * person read and agreed to, and applying it over a state they never saw would
 * make their confirmation evidence for something else.
 */
export async function executeRestockToLive(
  db: Database,
  audit: AuditRecorder,
  input: ExecuteRestockInput,
): Promise<AppliedRestock> {
  const operation = await beginExecution(db, input);
  if (operation === null) {
    throw new RestockRefused('this restock has not been confirmed, or has already run', 'state');
  }

  const preview = operation.preview as {
    quantity?: unknown;
    listingVersion?: unknown;
    entity?: { externalId?: unknown; variationId?: unknown };
  };
  const quantity = preview.quantity;
  const externalId = preview.entity?.externalId;

  if (typeof quantity !== 'number' || typeof externalId !== 'string') {
    await failExecution(db, { ...input, summary: 'the confirmed operation is incomplete' });
    throw new RestockRefused('the confirmed operation is incomplete', 'state');
  }

  const variationId = preview.entity?.variationId;
  const result = await input.adapter.listingOperations?.restockToLive?.({
    entity: {
      externalId,
      ...(typeof variationId === 'string' ? { variationId } : {}),
    },
    quantity,
    ...(typeof preview.listingVersion === 'string'
      ? { expectedVersion: preview.listingVersion }
      : {}),
    idempotencyKey: operation.idempotencyKey,
  });

  if (result === undefined) {
    await failExecution(db, { ...input, summary: 'this channel cannot return a listing to sale' });
    throw new RestockRefused('this channel cannot return a listing to sale', 'unsupported');
  }
  if (!isSuccess(result)) {
    await failExecution(db, { ...input, summary: describeFailure(result) });
    throw new RestockRefused(describeFailure(result), 'provider');
  }

  await completeExecution(db, {
    ...input,
    outcome: { quantity: result.value.quantity, state: result.value.state },
  });

  await audit.record(db, {
    action: 'listing.restocked_to_live',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: input.operationId,
    detail: {
      externalId,
      quantity: result.value.quantity,
      state: result.value.state,
    },
  });

  return { quantity: result.value.quantity, state: result.value.state };
}
