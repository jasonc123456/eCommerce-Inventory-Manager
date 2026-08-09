'use server';

import { PackageRefused, TrackingRefused, cancelPackage, markShipped } from '@eim/shipping';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { field } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

/**
 * The shipping decisions a browser can make on its own (sections 14, 20, 21).
 *
 * Two of them, and the boundary that leaves the rest out is the same one
 * milestone 5 drew for drafts and prices: an action here may change this
 * application's records, and anything that needs a provider credential belongs
 * with the code that holds one. Marking a parcel shipped and withdrawing an
 * unlabelled one are decisions about our own rows; quoting, buying, voiding,
 * fetching a document, and telling a channel are calls to somebody else's API.
 *
 * That boundary is why there is no "buy this label" button here. A label
 * purchase becomes a proposal, appears on the operations screen, and is
 * confirmed there like every other reviewed operation — which is what section 21
 * asks for anyway: "purchase label after cost confirmation".
 */

export interface ShippingFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
  readonly reason?: string;
}

export async function markShippedAction(
  _previous: ShippingFormState,
  form: FormData,
): Promise<ShippingFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const packageId = field(form, 'packageId');

  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    await context.audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId,
      detail: { reason: 'not_a_member', packageId },
    });

    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  try {
    await markShipped(db, context.audit, { businessId, packageId, subject });
  } catch (error) {
    if (error instanceof TrackingRefused) {
      return { status: 'error', message: error.message, reason: error.reason };
    }
    throw error;
  }

  revalidatePath('/shipping');

  return {
    status: 'done',
    // What has actually happened, and what has not. Telling the channel is a
    // separate act with its own permission, and claiming it here would be a
    // statement about a shop this action has not contacted.
    message: 'Marked shipped. The channel has not been told yet.',
  };
}

export async function cancelPackageAction(
  _previous: ShippingFormState,
  form: FormData,
): Promise<ShippingFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const packageId = field(form, 'packageId');

  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  try {
    // Only an unlabelled package can be withdrawn, and `cancelPackage` is what
    // enforces that. A labelled one holds a purchase that cost money; making it
    // disappear would leave the label paid for and attached to nothing, which is
    // what voiding exists to handle instead.
    await cancelPackage(db, context.audit, { businessId, packageId });
  } catch (error) {
    if (error instanceof PackageRefused) {
      return { status: 'error', message: error.message, reason: error.reason };
    }
    throw error;
  }

  revalidatePath('/shipping');

  return { status: 'done', message: 'Withdrawn. Its contents are available to pack again.' };
}
