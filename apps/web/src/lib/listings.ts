import { authorize, type BusinessPermission } from '@eim/authz';
import { reviewedOperations, type ReviewedOperation, type ReviewedOperationKind } from '@eim/db';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { identity } from './identity';
import { runtime } from './runtime';

/**
 * Reading what is waiting for somebody to decide (sections 11, 13, 14, 30).
 *
 * The screen this feeds is the only place a reviewed operation becomes visible,
 * and what it shows is the preview stored on the row rather than a fresh
 * rendering of current state. That is deliberate and it is the point of the
 * whole mechanism: a person confirms the values they were shown, so those are
 * the values the screen must keep showing, even once the world has moved.
 *
 * When the world has moved, the confirmation is refused. Redrawing the screen
 * from live data instead would mean somebody could read one set of numbers and
 * agree to another without either of them ever disagreeing on screen.
 */

/** How the screen labels each kind, in the language section 30 uses. */
export const OPERATION_LABELS: Readonly<Record<ReviewedOperationKind, string>> = {
  draft_create: 'Create a destination draft',
  draft_publish: 'Publish a draft',
  price_copy: 'Copy a price',
  restock_to_live: 'Return a listing to sale',
  order_copy: 'Copy an order to WooCommerce',
  label_purchase: 'Buy a shipping label',
};

export interface OpenOperation {
  readonly operation: ReviewedOperation;
  readonly label: string;
  /** Whether this caller may confirm it, as `authorize` decides. */
  readonly mayConfirm: boolean;
  /** Whether the session has authenticated recently enough, if it must have. */
  readonly stepUpSatisfied: boolean;
}

/**
 * Everything awaiting a decision in this business, newest first.
 *
 * Bounded, and scoped to the business the caller is acting in. There is no
 * cross-business view: an operation is a decision about one shop's listings, and
 * an installation-wide list of them would be a queue nobody owns.
 */
export async function loadOpenOperations(
  businessId: string,
  userId: string,
  hasRecentAuthentication: boolean,
  limit = 50,
): Promise<OpenOperation[]> {
  const { db } = runtime();
  const subject = await identity().memberships.loadSubject(db, businessId, userId);

  if (subject === null) {
    return [];
  }

  const rows = await db
    .select()
    .from(reviewedOperations)
    .where(
      and(
        eq(reviewedOperations.businessId, businessId),
        inArray(reviewedOperations.state, ['proposed', 'confirmed', 'executing']),
      ),
    )
    .orderBy(desc(reviewedOperations.proposedAt))
    .limit(limit);

  return rows.map((operation) => ({
    operation,
    label: OPERATION_LABELS[operation.kind],
    // Asked here as well as at confirmation time. This one decides whether the
    // button is drawn; the one in `confirmOperation` decides whether anything
    // happens, and hiding a control is never the control.
    mayConfirm: authorize(subject, operation.requiredPermission as BusinessPermission).allowed,
    stepUpSatisfied: !operation.requiresRecentAuthentication || hasRecentAuthentication,
  }));
}

/**
 * The recent history, so a decision can be looked up after the fact.
 *
 * Includes the settled states — executed, failed, expired, cancelled — because
 * "nothing happened and here is why" is the answer somebody usually needs.
 */
export async function loadRecentOperations(
  businessId: string,
  limit = 25,
): Promise<ReviewedOperation[]> {
  const { db } = runtime();

  return db
    .select()
    .from(reviewedOperations)
    .where(
      and(
        eq(reviewedOperations.businessId, businessId),
        inArray(reviewedOperations.state, ['executed', 'failed', 'expired', 'cancelled']),
      ),
    )
    .orderBy(desc(reviewedOperations.proposedAt))
    .limit(limit);
}
