'use server';

import { authorize } from '@eim/authz';
import { connections } from '@eim/db';
import {
  disconnect,
  previewDisconnect,
  type DisconnectPreview,
  type ManualSetup,
} from '@eim/integrations';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCsrf } from '../../lib/csrf';
import { ebay, loadConnection } from '../../lib/connections';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext, hasStepUp } from '../../lib/session';
import { field, trimmedField } from '../../lib/forms';
import { woocommerce } from '../../lib/woocommerce';

/**
 * Connecting, testing, and disconnecting providers (sections 13, 14, 21).
 *
 * Every action does the same four things in the same order: resolve the session,
 * resolve the subject in the business being acted on, ask `authorize`, and only
 * then act. The business identifier comes from the form and is never trusted —
 * the subject is loaded *for that business*, so naming one you are not a member
 * of produces a subject of null and a denial.
 *
 * `manage_integrations` is a step-up permission. Connecting a provider hands
 * this installation a credential to somebody's shop, and disconnecting one
 * discards it; both are worth a recent sign-in.
 *
 * Nothing here returns a secret to the browser, with one deliberate exception:
 * the webhook secret from the manual-setup path, which exists only to be typed
 * into the store and is shown once at the moment it is generated. It is never
 * readable again.
 */

export interface ConnectionFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
  /** Section 14's manual fallback, shown once. */
  readonly manual?: ManualSetup;
  readonly preview?: DisconnectPreview;
}

async function requireIntegrationManagement(businessId: string, form: FormData) {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    await context.audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId,
      detail: { permission: 'manage_integrations', reason: 'not_a_member' },
    });

    return { context, denied: 'You are not a member of that business.' as const };
  }

  const decision = authorize(subject, 'manage_integrations');

  if (!decision.allowed) {
    await context.audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId,
      detail: { permission: 'manage_integrations', reason: decision.reason },
    });

    return { context, denied: 'You cannot manage integrations in this business.' as const };
  }

  if (!hasStepUp(context)) {
    return {
      context,
      denied:
        'Sign in again before changing a provider connection. This needs a recent sign-in.' as const,
    };
  }

  // Checked last, once the session it is derived from is in hand. Throwing here
  // rather than returning a denial is deliberate: a missing token is not a
  // decision about permission, it is a request that did not come from this
  // application's own form.
  assertCsrf(form, context.session);

  return { context, denied: null };
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

export async function connectEbayAction(
  _previous: ConnectionFormState,
  form: FormData,
): Promise<ConnectionFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const environment = field(form, 'environment') === 'sandbox' ? 'sandbox' : 'production';
  const connectionId = trimmedField(form, 'connectionId');

  const { context, denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return { status: 'error', message: denied };
  }

  const begun = await ebay().oauth.begin({
    businessId,
    environment,
    userId: context.user.id,
    ...(connectionId === '' ? {} : { connectionId }),
  });

  if (!begun.ok) {
    return {
      status: 'error',
      message:
        'This installation has no eBay credentials for that environment. An administrator sets them in the environment file.',
    };
  }

  await context.audit.record(db, {
    action: 'connection.authorization_started',
    result: 'success',
    businessId,
    detail: { provider: 'ebay', environment },
  });

  redirect(begun.url);
}

export async function connectStoreAction(
  _previous: ConnectionFormState,
  form: FormData,
): Promise<ConnectionFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const storeUrl = trimmedField(form, 'storeUrl');
  const connectionId = trimmedField(form, 'connectionId');

  const { context, denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return { status: 'error', message: denied };
  }

  const begun = await woocommerce().connections.begin({
    businessId,
    userId: context.user.id,
    storeUrl,
    ...(connectionId === '' ? {} : { connectionId }),
  });

  if (!begun.ok) {
    // The detail is this application's own words about an address the operator
    // typed, never a quoted provider response — section 19 keeps provider error
    // bodies out of the interface.
    return { status: 'error', message: begun.detail };
  }

  await context.audit.record(db, {
    action: 'connection.authorization_started',
    result: 'success',
    businessId,
    detail: { provider: 'woocommerce', store: begun.store.origin },
  });

  redirect(begun.url);
}

export async function connectStoreManuallyAction(
  _previous: ConnectionFormState,
  form: FormData,
): Promise<ConnectionFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const storeUrl = trimmedField(form, 'storeUrl');
  const consumerKey = trimmedField(form, 'consumerKey');
  const consumerSecret = trimmedField(form, 'consumerSecret');

  const { context, denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return { status: 'error', message: denied };
  }

  if (consumerKey === '' || consumerSecret === '') {
    return { status: 'error', message: 'Enter both the consumer key and the consumer secret.' };
  }

  const connected = await woocommerce().connections.connectManually({
    businessId,
    userId: context.user.id,
    storeUrl,
    consumerKey,
    consumerSecret,
  });

  if (!connected.ok) {
    await context.audit.record(db, {
      action: 'connection.rejected',
      result: 'denied',
      businessId,
      detail: { provider: 'woocommerce', reason: connected.reason },
    });

    return { status: 'error', message: describeStoreFailure(connected.reason) };
  }

  await context.audit.record(db, {
    action: 'connection.connected',
    result: 'success',
    businessId,
    targetType: 'connection',
    targetId: connected.connectionId,
    detail: { provider: 'woocommerce', permissions: connected.permissions },
  });

  revalidatePath('/connections');

  return {
    status: 'done',
    message:
      connected.impairedCapabilities.length === 0
        ? 'The store is connected.'
        : `The store is connected. The key is ${connected.permissions}, so ${connected.impairedCapabilities.join(', ')} are unavailable.`,
  };
}

// ---------------------------------------------------------------------------
// Maintaining
// ---------------------------------------------------------------------------

/** Section 21's "test": runs the readiness checks against the provider. */
export async function testConnectionAction(form: FormData): Promise<void> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const connectionId = field(form, 'connectionId');

  const { context, denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return;
  }

  const connection = await loadConnection(db, businessId, connectionId);

  if (connection === null) {
    return;
  }

  const report =
    connection.provider === 'ebay'
      ? await ebay().readiness.assess({ businessId, connectionId })
      : await woocommerce().readiness.assess({ businessId, connectionId });

  await context.audit.record(db, {
    action: 'connection.tested',
    result: 'success',
    businessId,
    targetType: 'connection',
    targetId: connectionId,
    detail: { available: report.available, blocked: report.blocked.map((row) => row.capability) },
  });

  revalidatePath('/connections');
}

/** Section 14's overlapping secret rotation. */
export async function rotateWebhookSecretsAction(form: FormData): Promise<void> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const connectionId = field(form, 'connectionId');

  const { context, denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return;
  }

  const connection = await loadConnection(db, businessId, connectionId);

  if (connection?.provider !== 'woocommerce') {
    return;
  }

  const report = await woocommerce().webhooks.rotate({ businessId, connectionId });

  await context.audit.record(db, {
    action: 'connection.webhook_rotation_started',
    result: 'success',
    businessId,
    targetType: 'connection',
    targetId: connectionId,
    detail: { topics: report.outcomes.map((outcome) => outcome.topic) },
  });

  revalidatePath('/connections');
}

/** Brings every managed registration back to what it should be. */
export async function reconcileWebhooksAction(form: FormData): Promise<void> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const connectionId = field(form, 'connectionId');

  const { context, denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return;
  }

  const connection = await loadConnection(db, businessId, connectionId);

  if (connection?.provider !== 'woocommerce') {
    return;
  }

  const report = await woocommerce().webhooks.reconcile({ businessId, connectionId });

  await context.audit.record(db, {
    action: 'connection.webhooks_reconciled',
    result: 'success',
    businessId,
    targetType: 'connection',
    targetId: connectionId,
    detail: {
      actions: report.outcomes.map((outcome) => `${outcome.topic}:${outcome.action}`),
      pollingRequired: report.pollingRequired,
    },
  });

  revalidatePath('/connections');
}

export async function setConnectionPausedAction(form: FormData): Promise<void> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const connectionId = field(form, 'connectionId');
  const pause = field(form, 'intent') === 'pause';

  const { context, denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return;
  }

  const connection = await loadConnection(db, businessId, connectionId);

  if (connection === null || connection.status === 'disconnected') {
    return;
  }

  await db
    .update(connections)
    .set(
      pause
        ? { status: 'paused', pauseReason: 'paused by an operator', updatedAt: new Date() }
        : // Resuming clears the reason as well as the status. A connection that
          // is active and still carries a pause reason is one whose screen says
          // two contradictory things, and the database refuses it anyway.
          { status: 'active', pauseReason: null, updatedAt: new Date() },
    )
    .where(and(eq(connections.id, connectionId), eq(connections.businessId, businessId)));

  await context.audit.record(db, {
    action: pause ? 'connection.paused' : 'connection.resumed',
    result: 'success',
    businessId,
    targetType: 'connection',
    targetId: connectionId,
    detail: { provider: connection.provider },
  });

  revalidatePath('/connections');
}

// ---------------------------------------------------------------------------
// Disconnecting
// ---------------------------------------------------------------------------

/**
 * Section 14's impact preview.
 *
 * A separate action from the disconnection itself, so the operator sees what
 * will happen and then decides. A single action with a confirmation checkbox
 * would mean the preview and the act share a code path whose behaviour depends
 * on a boolean.
 */
export async function previewDisconnectAction(
  _previous: ConnectionFormState,
  form: FormData,
): Promise<ConnectionFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const connectionId = field(form, 'connectionId');

  const { denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return { status: 'error', message: denied };
  }

  const preview = await previewDisconnect(db, { businessId, connectionId });

  return preview === null
    ? { status: 'error', message: 'That connection no longer exists.' }
    : { status: 'done', preview };
}

export async function disconnectConnectionAction(
  _previous: ConnectionFormState,
  form: FormData,
): Promise<ConnectionFormState> {
  const { db } = runtime();
  const businessId = field(form, 'businessId');
  const connectionId = field(form, 'connectionId');

  const { context, denied } = await requireIntegrationManagement(businessId, form);

  if (denied !== null) {
    return { status: 'error', message: denied };
  }

  const connection = await loadConnection(db, businessId, connectionId);

  if (connection === null) {
    return { status: 'error', message: 'That connection no longer exists.' };
  }

  const { secrets, webhooks } = woocommerce();

  const outcome = await disconnect(
    {
      db,
      secrets,
      // Only WooCommerce registrations are deleted at the provider. eBay's
      // notification destination belongs to the application keyset rather than
      // to any one seller, so removing it here would silence every other
      // connected seller.
      ...(connection.provider === 'woocommerce'
        ? {
            deleteWebhook: async (input) => {
              const report = await webhooks.remove(input);

              return report.outcomes.every((entry) => entry.action === 'removed');
            },
          }
        : {}),
    },
    { businessId, connectionId },
  );

  await context.audit.record(db, {
    action: 'connection.disconnected',
    result: 'success',
    businessId,
    targetType: 'connection',
    targetId: connectionId,
    detail: {
      provider: connection.provider,
      webhooksDeleted: outcome.webhooksDeleted,
      webhooksFailed: outcome.webhooksFailed,
      credentialsDiscarded: outcome.credentialsDiscarded,
    },
  });

  revalidatePath('/connections');

  return {
    status: 'done',
    message:
      outcome.webhooksFailed === 0
        ? 'The connection is disconnected and its credentials have been discarded.'
        : `The connection is disconnected and its credentials have been discarded. ${String(outcome.webhooksFailed)} webhook registration${outcome.webhooksFailed === 1 ? '' : 's'} could not be removed at the provider and should be deleted there by hand.`,
  };
}

// ---------------------------------------------------------------------------

function describeStoreFailure(reason: string): string {
  switch (reason) {
    case 'credentials_rejected':
      return 'The store did not accept that key. Check that it was copied in full and has read access.';
    case 'unreachable':
      return 'The store could not be reached. Check the address and that the site is up.';
    case 'invalid_url':
      return 'That address is not one this installation may connect to.';
    case 'unknown_connection':
      return 'That connection no longer exists.';
    default:
      return 'The store could not be connected.';
  }
}
