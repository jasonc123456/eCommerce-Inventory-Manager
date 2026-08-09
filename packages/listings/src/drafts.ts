import type { AuditRecorder } from '@eim/audit';
import { reviewedOperations, type Database } from '@eim/db';
import {
  describeFailure,
  isSuccess,
  type ChannelAdapter,
  type PublicationPreview,
} from '@eim/providers';
import {
  beginExecution,
  completeExecution,
  failExecution,
  proposeOperation,
  type FingerprintValue,
  type ProposedOperation,
} from '@eim/review';
import { and, eq } from 'drizzle-orm';

import {
  assessDraftEligibility,
  mayConvert,
  type DraftPlatform,
  type DraftSource,
} from './draft-eligibility';
import { applySelections, draftIsComplete, projectDraft, type DraftSubject } from './draft-fields';

/**
 * Two stages, two confirmations (sections 6, 10, 13, 14, 30).
 *
 * Section 14 states the rule plainly — "saving destination draft and publishing
 * are separate confirmations" — and section 13 says the same for eBay by
 * requiring "separate confirmation" for publication on top of everything a draft
 * already needed. So this module has two entry points and no path from the first
 * to the second: creating a draft cannot publish it, and publishing requires
 * proposing a second operation, from a second read, confirmed by somebody who
 * saw the fees.
 *
 * That is why the fee preview is fetched when the *publish* operation is
 * proposed rather than carried forward from the draft. Fees quoted an hour ago
 * against a draft that has since been edited are not this publication's fees,
 * and the whole value of section 30's AC-10 — "fee/currency impact [and] exact
 * confirmation" — is that the number on the screen is the number that will be
 * charged. The quote is the source read; its age is what the freshness window
 * measures.
 *
 * Nothing in this module runs unattended. Both entry points require an operation
 * a person has already confirmed, and the package they live in cannot be
 * imported by the scheduler or the worker.
 */

export interface ProposeDraftInput {
  readonly businessId: string;
  readonly destination: DraftPlatform;
  readonly destinationConnectionId: string;
  /** What is being converted, for the section 6 verdict. */
  readonly source: DraftSource;
  readonly subject: DraftSubject;
  /** Choices the reviewer has already made, such as an eBay category. */
  readonly selections?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  /** When the source record was read from its provider. */
  readonly sourceObservedAt: Date;
  readonly actorUserId: string;
  readonly canonicalItemId?: string;
  readonly sourceConnectionId?: string;
  /** Identifies the source entity, so a repeat finds the same proposal. */
  readonly subjectKey: string;
  readonly now?: Date;
}

export class DraftRefused extends Error {
  public readonly verdict: string;

  constructor(message: string, verdict: string) {
    super(message);
    this.name = 'DraftRefused';
    this.verdict = verdict;
  }
}

export interface ProposedDraft extends ProposedOperation {
  readonly missing: readonly string[];
  readonly requiresSelection: readonly string[];
  readonly unsupported: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Records a proposal to create a draft on the other platform.
 *
 * Refuses outright when section 6 says the type cannot be converted, and only
 * then. Incompleteness is not a refusal: a draft with an unchosen category is
 * exactly what somebody sits down to finish, and blocking the proposal until
 * every field is filled would mean the review had to happen before the thing
 * being reviewed existed.
 */
export async function proposeDraft(
  db: Database,
  audit: AuditRecorder,
  input: ProposeDraftInput,
): Promise<ProposedDraft> {
  const eligibility = assessDraftEligibility(input.source);
  if (!mayConvert(eligibility)) {
    throw new DraftRefused(eligibility.reason, eligibility.verdict);
  }

  const projected = projectDraft({ subject: input.subject, destination: input.destination });
  const projection = applySelections(projected, input.selections ?? {});

  const decisive: FingerprintValue = {
    destination: input.destination,
    fields: projection.fields as Record<string, FingerprintValue>,
    // Included in the hash on purpose. A reviewer who agreed to a conversion
    // that would drop two fields has not agreed to one that drops five, and a
    // source edited between the proposal and the confirmation can change
    // exactly that without changing a single carried value.
    unsupported: [...projection.unsupported],
    missing: [...projection.missing],
  };

  const proposal = await proposeOperation(db, {
    businessId: input.businessId,
    kind: 'draft_create',
    subjectKey: input.subjectKey,
    requiredPermission: 'create_drafts',
    preview: {
      destination: input.destination,
      eligibility: { verdict: eligibility.verdict, reason: eligibility.reason },
      fields: projection.fields,
      missing: projection.missing,
      requiresSelection: projection.requiresSelection,
      unsupported: projection.unsupported,
      warnings: [...eligibility.warnings, ...projection.warnings],
    },
    decisive,
    sourceObservedAt: input.sourceObservedAt,
    proposedByUserId: input.actorUserId,
    idempotencyKey: `draft:${input.businessId}:${input.subjectKey}:${String(Date.now())}`,
    destinationConnectionId: input.destinationConnectionId,
    ...(input.canonicalItemId === undefined ? {} : { canonicalItemId: input.canonicalItemId }),
    ...(input.sourceConnectionId === undefined
      ? {}
      : { sourceConnectionId: input.sourceConnectionId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  await audit.record(db, {
    action: 'listing.operation.proposed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: proposal.operationId,
    detail: {
      kind: 'draft_create',
      destination: input.destination,
      missing: projection.missing,
      unsupported: projection.unsupported,
    },
  });

  return {
    ...proposal,
    missing: projection.missing,
    requiresSelection: projection.requiresSelection,
    unsupported: projection.unsupported,
    warnings: [...eligibility.warnings, ...projection.warnings],
  };
}

export interface ExecuteInput {
  readonly businessId: string;
  readonly operationId: string;
  readonly adapter: ChannelAdapter;
}

export interface CreatedDraft {
  readonly externalDraftId: string;
}

/**
 * Creates the draft a person confirmed.
 *
 * Reads the fields back out of the operation rather than taking them from the
 * caller. What was confirmed is what is on the row; a caller that supplied them
 * again could supply different ones, and the confirmation would then be evidence
 * for a change nobody saw.
 */
export async function executeDraftCreation(
  db: Database,
  audit: AuditRecorder,
  input: ExecuteInput,
): Promise<CreatedDraft> {
  const operation = await beginExecution(db, input);
  if (operation === null) {
    throw new DraftRefused('this operation has not been confirmed, or has already run', 'state');
  }

  const preview = operation.preview as { fields?: Record<string, never> };

  // Called through the optional chain rather than pulled out into a variable
  // first: a channel with no draft support short-circuits to `undefined` here
  // without anything being invoked, and there is no detached method reference
  // whose `this` could be lost on the way.
  const result = await input.adapter.listingOperations?.createDraft?.({
    fields: preview.fields ?? {},
    idempotencyKey: operation.idempotencyKey,
  });

  if (result === undefined) {
    await failExecution(db, { ...input, summary: 'this channel cannot create drafts' });
    throw new DraftRefused('this channel cannot create drafts', 'unsupported');
  }

  if (!isSuccess(result)) {
    await failExecution(db, { ...input, summary: describeFailure(result) });
    throw new DraftRefused(describeFailure(result), 'provider');
  }

  await completeExecution(db, {
    ...input,
    outcome: { externalDraftId: result.value.externalDraftId },
  });

  await audit.record(db, {
    action: 'listing.draft.created',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: input.operationId,
    detail: { externalDraftId: result.value.externalDraftId },
  });

  return { externalDraftId: result.value.externalDraftId };
}

export interface ProposePublicationInput {
  readonly businessId: string;
  /** The confirmed and executed draft creation this publishes. */
  readonly draftOperationId: string;
  readonly adapter: ChannelAdapter;
  readonly actorUserId: string;
  readonly now?: Date;
}

export interface ProposedPublication extends ProposedOperation {
  readonly externalDraftId: string;
  readonly fees: PublicationPreview['fees'];
  readonly totalAmount?: string;
  readonly currency?: string;
  readonly warnings: readonly string[];
}

/**
 * Quotes the fees and records a second proposal.
 *
 * The provider's refusal to publish is treated as a refusal to propose. Showing
 * somebody a confirmation button above a list of reasons the provider will
 * reject the listing invites them to press it and learn nothing they could not
 * have been told first.
 */
export async function proposePublication(
  db: Database,
  audit: AuditRecorder,
  input: ProposePublicationInput,
): Promise<ProposedPublication> {
  const rows = await db
    .select()
    .from(reviewedOperations)
    .where(
      and(
        eq(reviewedOperations.id, input.draftOperationId),
        eq(reviewedOperations.businessId, input.businessId),
        eq(reviewedOperations.kind, 'draft_create'),
        eq(reviewedOperations.state, 'executed'),
      ),
    )
    .limit(1);

  const draftOperation = rows[0];
  if (draftOperation === undefined) {
    throw new DraftRefused('there is no created draft to publish', 'state');
  }

  const outcome = draftOperation.outcome as { externalDraftId?: unknown } | null;
  const externalDraftId = outcome?.externalDraftId;
  if (typeof externalDraftId !== 'string') {
    throw new DraftRefused('the draft creation did not record a draft identifier', 'state');
  }

  // This call is the source read. Its instant is what the freshness window
  // measures, which is why it is taken here and not carried from the draft.
  const quotedAt = input.now ?? new Date();
  const quote = await input.adapter.listingOperations?.previewPublication?.({ externalDraftId });

  if (quote === undefined) {
    throw new DraftRefused('this channel cannot quote publication fees', 'unsupported');
  }

  if (!isSuccess(quote)) {
    throw new DraftRefused(describeFailure(quote), 'provider');
  }

  if (quote.value.blockers.length > 0) {
    throw new DraftRefused(
      `the provider would refuse this publication: ${quote.value.blockers.join('; ')}`,
      'blocked',
    );
  }

  const decisive: FingerprintValue = {
    externalDraftId,
    // The fees are part of what is being agreed to, not an annotation beside
    // it. A provider that re-quotes a different insertion fee has changed the
    // decision, and the confirmation must be refused rather than applied.
    fees: quote.value.fees.map((fee) => ({
      label: fee.label,
      amount: fee.amount,
      currency: fee.currency,
    })),
    totalAmount: quote.value.totalAmount ?? null,
    currency: quote.value.currency ?? null,
  };

  const proposal = await proposeOperation(db, {
    businessId: input.businessId,
    kind: 'draft_publish',
    subjectKey: `draft:${externalDraftId}`,
    requiredPermission:
      draftOperation.preview !== null &&
      (draftOperation.preview as { destination?: unknown }).destination === 'woocommerce'
        ? 'publish_products'
        : 'publish_listings',
    preview: {
      externalDraftId,
      fees: quote.value.fees,
      totalAmount: quote.value.totalAmount,
      currency: quote.value.currency,
      warnings: quote.value.warnings,
    },
    decisive,
    sourceObservedAt: quotedAt,
    proposedByUserId: input.actorUserId,
    idempotencyKey: `publish:${input.businessId}:${externalDraftId}`,
    parentOperationId: draftOperation.id,
    externalReference: externalDraftId,
    ...(draftOperation.destinationConnectionId === null
      ? {}
      : { destinationConnectionId: draftOperation.destinationConnectionId }),
    ...(draftOperation.canonicalItemId === null
      ? {}
      : { canonicalItemId: draftOperation.canonicalItemId }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  await audit.record(db, {
    action: 'listing.operation.proposed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: proposal.operationId,
    detail: {
      kind: 'draft_publish',
      externalDraftId,
      totalFees: quote.value.totalAmount,
      currency: quote.value.currency,
    },
  });

  return {
    ...proposal,
    externalDraftId,
    fees: quote.value.fees,
    ...(quote.value.totalAmount === undefined ? {} : { totalAmount: quote.value.totalAmount }),
    ...(quote.value.currency === undefined ? {} : { currency: quote.value.currency }),
    warnings: quote.value.warnings,
  };
}

export interface PublishedDraft {
  readonly externalListingId: string;
  readonly revisableOnlyThroughApi: boolean;
}

/** Publishes the draft somebody confirmed, having seen its fees. */
export async function executePublication(
  db: Database,
  audit: AuditRecorder,
  input: ExecuteInput,
): Promise<PublishedDraft> {
  const operation = await beginExecution(db, input);
  if (operation === null) {
    throw new DraftRefused('this publication has not been confirmed, or has already run', 'state');
  }

  const externalDraftId = operation.externalReference;
  if (externalDraftId === null) {
    await failExecution(db, { ...input, summary: 'the operation names no draft' });
    throw new DraftRefused('the operation names no draft', 'state');
  }

  const result = await input.adapter.listingOperations?.publishDraft?.({
    externalDraftId,
    idempotencyKey: operation.idempotencyKey,
  });

  if (result === undefined) {
    await failExecution(db, { ...input, summary: 'this channel cannot publish drafts' });
    throw new DraftRefused('this channel cannot publish drafts', 'unsupported');
  }

  if (!isSuccess(result)) {
    await failExecution(db, { ...input, summary: describeFailure(result) });
    throw new DraftRefused(describeFailure(result), 'provider');
  }

  await completeExecution(db, {
    ...input,
    outcome: { externalListingId: result.value.externalListingId },
  });

  await audit.record(db, {
    action: 'listing.draft.published',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: input.operationId,
    detail: {
      externalDraftId,
      externalListingId: result.value.externalListingId,
      permission: operation.requiredPermission,
    },
  });

  return {
    externalListingId: result.value.externalListingId,
    revisableOnlyThroughApi: result.value.revisableOnlyThroughApi ?? false,
  };
}

/** Re-exported so a screen can ask the same question the proposal will. */
export { draftIsComplete };
