import { authorize, STEP_UP_PERMISSIONS, type BusinessPermission, type Subject } from '@eim/authz';
import {
  reviewedOperationRefusals,
  reviewedOperations,
  type Database,
  type ReviewedOperation,
  type ReviewedOperationKind,
  type ReviewedOperationRefusalReason,
} from '@eim/db';
import { and, eq, lt, sql } from 'drizzle-orm';

import { fingerprintMatches, fingerprintOf, type FingerprintValue } from './fingerprint';
import { assessFreshness, reviewWindowFor } from './freshness';

/**
 * Propose, confirm, execute — once (sections 11, 13, 14, 30).
 *
 * Every milestone-5 operation runs through this module, and the reason to have
 * one gate rather than five is that the five guarantees are identical and none
 * of them is the interesting part of any individual feature. Publishing a
 * listing and copying a price share nothing about what they do and everything
 * about what has to be true before they are allowed to happen: somebody with the
 * right permission, authenticated recently enough, agreed to this exact set of
 * values, which were read from the provider recently enough to still be true,
 * and the effect happens once.
 *
 * Written five times, one of them would eventually check the fingerprint after
 * the write, or forget the freshness window, or treat a missing permission as a
 * warning. Written once, the only way to add an operation is to inherit all of
 * it.
 *
 * There is no `execute` here, deliberately. This module decides whether an
 * operation may proceed and records that it did; what actually reaches a
 * provider lives with the feature that knows how to talk to one. That boundary
 * is what keeps `@eim/sync` — the automatic path — from being able to reach an
 * execution at all.
 */

export interface ProposeOperationInput {
  readonly businessId: string;
  readonly kind: ReviewedOperationKind;
  /** What this is about. A second proposal for the same subject collides. */
  readonly subjectKey: string;
  readonly requiredPermission: BusinessPermission;
  /** Everything shown to the reviewer, including explanatory detail. */
  readonly preview: Readonly<Record<string, unknown>>;
  /**
   * The subset a decision turns on. Hashed, and compared at confirmation.
   *
   * Separate from `preview` because a preview carries things that are true but
   * not being agreed to — when it was generated, who generated it, prose
   * explaining a warning. Hashing those would expire a proposal the moment it
   * was rendered a second time.
   */
  readonly decisive: FingerprintValue;
  /** When the provider values inside the preview were read. */
  readonly sourceObservedAt: Date;
  readonly proposedByUserId: string;
  readonly idempotencyKey: string;
  readonly mappingId?: string;
  readonly canonicalItemId?: string;
  readonly sourceConnectionId?: string;
  readonly destinationConnectionId?: string;
  readonly externalReference?: string;
  readonly parentOperationId?: string;
  readonly now?: Date;
}

export interface ProposedOperation {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly expiresAt: Date;
  readonly sourceMaxAgeMs: number;
}

export class ReviewedOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewedOperationError';
  }
}

/**
 * Records a proposal and returns the fingerprint the reviewer must send back.
 *
 * A second live proposal for the same subject is refused by the database rather
 * than by a check here, because a check here loses the race that matters: two
 * people opening the same listing at the same time. The caller gets a clear
 * error naming the subject, which is what the screen should say anyway.
 */
export async function proposeOperation(
  db: Database,
  input: ProposeOperationInput,
): Promise<ProposedOperation> {
  const now = input.now ?? new Date();
  const window = reviewWindowFor(input.kind);
  const fingerprint = fingerprintOf(input.decisive);
  const expiresAt = new Date(now.getTime() + window.proposalTtlMs);

  // Recorded on the row rather than consulted from the catalogue at
  // confirmation. What a proposal demanded must not change under it because a
  // deployment changed the catalogue between the two clicks.
  const requiresRecentAuthentication = STEP_UP_PERMISSIONS.has(input.requiredPermission);

  const inserted = await db
    .insert(reviewedOperations)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      subjectKey: input.subjectKey,
      requiredPermission: input.requiredPermission,
      requiresRecentAuthentication,
      preview: input.preview,
      previewFingerprint: fingerprint,
      sourceObservedAt: input.sourceObservedAt,
      sourceMaxAgeMs: window.sourceMaxAgeMs,
      expiresAt,
      idempotencyKey: input.idempotencyKey,
      proposedByUserId: input.proposedByUserId,
      proposedAt: now,
      ...(input.mappingId === undefined ? {} : { mappingId: input.mappingId }),
      ...(input.canonicalItemId === undefined ? {} : { canonicalItemId: input.canonicalItemId }),
      ...(input.sourceConnectionId === undefined
        ? {}
        : { sourceConnectionId: input.sourceConnectionId }),
      ...(input.destinationConnectionId === undefined
        ? {}
        : { destinationConnectionId: input.destinationConnectionId }),
      ...(input.externalReference === undefined
        ? {}
        : { externalReference: input.externalReference }),
      ...(input.parentOperationId === undefined
        ? {}
        : { parentOperationId: input.parentOperationId }),
    })
    .returning({ id: reviewedOperations.id });

  const row = inserted[0];
  if (row === undefined) {
    throw new ReviewedOperationError('proposing an operation returned nothing');
  }

  return {
    operationId: row.id,
    fingerprint,
    expiresAt,
    sourceMaxAgeMs: window.sourceMaxAgeMs,
  };
}

export interface ConfirmOperationInput {
  readonly businessId: string;
  readonly operationId: string;
  /** The confirming user's permissions, as the authorization layer sees them. */
  readonly subject: Subject;
  /** The fingerprint of the screen the confirmer actually read. */
  readonly fingerprint: string;
  /** Whether this session has authenticated within the step-up window. */
  readonly hasRecentAuthentication: boolean;
  readonly now?: Date;
}

export interface ConfirmedOperation {
  readonly confirmed: true;
  readonly operation: ReviewedOperation;
  /** Carry this to the provider on every attempt. */
  readonly idempotencyKey: string;
}

export interface RefusedOperation {
  readonly confirmed: false;
  readonly reason: ReviewedOperationRefusalReason;
  readonly detail: string;
}

export type ConfirmOutcome = ConfirmedOperation | RefusedOperation;

/**
 * The gate.
 *
 * The order of the checks is a decision, not an accident. Permission comes
 * first: somebody who may not perform this operation learns only that, and not
 * whether the price moved or when the read was taken. Recent authentication
 * comes next, because it is also a property of the caller rather than of the
 * world, and a step-up prompt is a better thing to show than a staleness error
 * the user cannot act on until they have re-authenticated anyway.
 *
 * State, expiry, fingerprint, and freshness follow, in increasing order of how
 * much they depend on the outside world having moved.
 *
 * Every refusal is written down. A gate with no record of ever having refused
 * anything is indistinguishable from an open door, and the refusals are the only
 * evidence that the freshness and fingerprint rules ever fire in production.
 */
export async function confirmOperation(
  db: Database,
  input: ConfirmOperationInput,
): Promise<ConfirmOutcome> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    // Locked for the duration: two confirmations of the same proposal arriving
    // together must not both pass the state check and both move it to confirmed.
    const rows = await tx
      .select()
      .from(reviewedOperations)
      .where(
        and(
          eq(reviewedOperations.id, input.operationId),
          eq(reviewedOperations.businessId, input.businessId),
        ),
      )
      .for('update')
      .limit(1);

    const operation = rows[0];
    if (operation === undefined) {
      // No row, so no refusal to attach to one. Reported rather than recorded;
      // an id that does not exist in this business is an authorization question,
      // and the caller's audit trail is where it belongs.
      return {
        confirmed: false,
        reason: 'already_decided',
        detail: 'this operation does not exist in this business',
      } as const;
    }

    const refuse = async (
      reason: ReviewedOperationRefusalReason,
      detail: string,
    ): Promise<RefusedOperation> => {
      await tx.insert(reviewedOperationRefusals).values({
        operationId: operation.id,
        businessId: operation.businessId,
        reason,
        attemptedByUserId: input.subject.userId,
        detail,
        refusedAt: now,
      });
      return { confirmed: false, reason, detail };
    };

    const permission = operation.requiredPermission as BusinessPermission;
    const decision = authorize(input.subject, permission, {
      ...(operation.destinationConnectionId === null
        ? {}
        : { connectionId: operation.destinationConnectionId }),
    });
    if (!decision.allowed) {
      return refuse('not_permitted', `${permission} was refused: ${decision.reason}`);
    }

    if (operation.requiresRecentAuthentication && !input.hasRecentAuthentication) {
      return refuse(
        'recent_authentication_required',
        `${permission} requires authentication within the step-up window`,
      );
    }

    if (operation.state !== 'proposed') {
      return refuse('already_decided', `this operation is already ${operation.state}`);
    }

    const verdict = assessFreshness({
      sourceObservedAt: operation.sourceObservedAt,
      sourceMaxAgeMs: operation.sourceMaxAgeMs,
      expiresAt: operation.expiresAt,
      now,
    });
    if (verdict === 'expired') {
      // Moved to `expired` as well as refused, so the subject is freed for a
      // fresh proposal rather than blocked by the one that just timed out.
      await tx
        .update(reviewedOperations)
        .set({ state: 'expired', settledAt: now })
        .where(eq(reviewedOperations.id, operation.id));
      return refuse('expired', 'this proposal expired before it was confirmed');
    }

    // Checked before freshness, because a fingerprint mismatch is the more
    // specific fact: it says the values moved, where staleness only says they
    // might have.
    if (!fingerprintMatches(operation.previewFingerprint, input.fingerprint)) {
      return refuse(
        'stale_preview',
        'the values changed after this was shown; review the new ones and confirm again',
      );
    }

    if (verdict === 'stale_source') {
      return refuse(
        'stale_source',
        'the source values are too old to act on; they must be read again',
      );
    }

    const confirmed = await tx
      .update(reviewedOperations)
      .set({
        state: 'confirmed',
        confirmedByUserId: input.subject.userId,
        confirmedAt: now,
      })
      .where(and(eq(reviewedOperations.id, operation.id), eq(reviewedOperations.state, 'proposed')))
      .returning();

    const row = confirmed[0];
    if (row === undefined) {
      // The row moved between the locked read and this update, which the lock
      // should make impossible. Refusing is the only safe reading.
      return refuse('already_decided', 'this operation was decided concurrently');
    }

    return { confirmed: true, operation: row, idempotencyKey: row.idempotencyKey } as const;
  });
}

/**
 * Claims a confirmed operation for execution.
 *
 * Separate from confirmation because a provider call can fail ambiguously and
 * has to be attempted again, and separate from a plain flag because the attempt
 * count is what tells an operator that an operation is stuck rather than slow.
 * Returns null when the operation is not in a state that may be executed, which
 * is how a second worker picking up the same row stands down.
 */
export async function beginExecution(
  db: Database,
  input: { readonly businessId: string; readonly operationId: string },
): Promise<ReviewedOperation | null> {
  const rows = await db
    .update(reviewedOperations)
    .set({ state: 'executing', attempts: sql`${reviewedOperations.attempts} + 1` })
    .where(
      and(
        eq(reviewedOperations.id, input.operationId),
        eq(reviewedOperations.businessId, input.businessId),
        // Either not started, or started and not yet settled. The second is the
        // ambiguous-timeout case: the same confirmation, tried again, under the
        // same idempotency key.
        sql`${reviewedOperations.state} in ('confirmed', 'executing')`,
      ),
    )
    .returning();

  return rows[0] ?? null;
}

/** Records that the effect happened. Terminal; the trigger enforces that. */
export async function completeExecution(
  db: Database,
  input: {
    readonly businessId: string;
    readonly operationId: string;
    readonly outcome: Readonly<Record<string, unknown>>;
    readonly now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();

  await db
    .update(reviewedOperations)
    .set({ state: 'executed', executedAt: now, settledAt: now, outcome: input.outcome })
    .where(
      and(
        eq(reviewedOperations.id, input.operationId),
        eq(reviewedOperations.businessId, input.businessId),
        eq(reviewedOperations.state, 'executing'),
      ),
    );
}

/**
 * Records that it did not, and will not be tried again under this confirmation.
 *
 * A failure is terminal on purpose. Retrying a provider call is `beginExecution`
 * again while the operation is still `executing`; reaching `failed` is the
 * decision that no further attempt will be made, and undoing that decision means
 * showing somebody the current values and asking again.
 */
export async function failExecution(
  db: Database,
  input: {
    readonly businessId: string;
    readonly operationId: string;
    readonly summary: string;
    readonly outcome?: Readonly<Record<string, unknown>>;
    readonly now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();

  await db
    .update(reviewedOperations)
    .set({
      state: 'failed',
      settledAt: now,
      failureSummary: input.summary,
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    })
    .where(
      and(
        eq(reviewedOperations.id, input.operationId),
        eq(reviewedOperations.businessId, input.businessId),
        sql`${reviewedOperations.state} in ('confirmed', 'executing')`,
      ),
    );
}

/** Withdraws a proposal nobody acted on. */
export async function cancelOperation(
  db: Database,
  input: { readonly businessId: string; readonly operationId: string; readonly now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();

  const rows = await db
    .update(reviewedOperations)
    .set({ state: 'cancelled', settledAt: now })
    .where(
      and(
        eq(reviewedOperations.id, input.operationId),
        eq(reviewedOperations.businessId, input.businessId),
        eq(reviewedOperations.state, 'proposed'),
      ),
    )
    .returning({ id: reviewedOperations.id });

  return rows.length === 1;
}

/**
 * Settles proposals nobody confirmed in time.
 *
 * Run periodically. Without it an abandoned proposal holds its subject's live
 * slot until somebody tries to confirm it, and the person who wanted to propose
 * a new one in the meantime is told the subject is busy by a row that will never
 * do anything.
 */
export async function expireProposals(
  db: Database,
  input: { readonly businessId?: string; readonly now?: Date } = {},
): Promise<number> {
  const now = input.now ?? new Date();

  const rows = await db
    .update(reviewedOperations)
    .set({ state: 'expired', settledAt: now })
    .where(
      and(
        eq(reviewedOperations.state, 'proposed'),
        lt(reviewedOperations.expiresAt, now),
        ...(input.businessId === undefined
          ? []
          : [eq(reviewedOperations.businessId, input.businessId)]),
      ),
    )
    .returning({ id: reviewedOperations.id });

  return rows.length;
}
