'use server';

import { createAuditRecorder } from '@eim/audit';
import { renderMagicLink } from '@eim/mail';
import { redirect } from 'next/navigation';

import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { requestMetadata } from '../../lib/session';
import { describeDevice } from '../../lib/sign-in';
import { field, trimmedField } from '../../lib/forms';

/**
 * Claiming an unclaimed installation (section 20).
 *
 * The screen has two steps because the flow has two factors: the configured
 * address receives a one-time link, and whoever opens it also presents the
 * setup secret from the deployment host's `.env`. Neither is sufficient alone,
 * and the responses here are careful not to say which one was wrong or whether
 * the address was the configured one.
 */

export interface SetupFormState {
  readonly status: 'idle' | 'sent' | 'error';
  readonly message?: string;
}

export async function requestSetupLinkAction(
  _previous: SetupFormState,
  form: FormData,
): Promise<SetupFormState> {
  const { db, config, logger } = runtime();
  const { bootstrap, mailer, productName } = identity();

  const email = trimmedField(form, 'email');
  const metadata = await requestMetadata();

  const audit = createAuditRecorder({
    actor: { userId: null, kind: 'system' },
    requestIp: metadata.clientAddress,
    requestUserAgent: metadata.userAgent,
  });

  const result = await bootstrap.requestSetupLink(db, email);

  if (result.outcome === 'issued') {
    const message = renderMagicLink({
      productName,
      publicUrl: config.EIM_PUBLIC_URL,
      token: result.token,
      expiresInMinutes: 15,
      path: '/setup?step=complete',
      tokenCarrier: config.EIM_MAGIC_LINK_TOKEN_CARRIER,
      ...(metadata.userAgent === null ? {} : { requestedFrom: describeDevice(metadata.userAgent) }),
    });

    const delivery = await mailer.send({ ...message, to: email });

    if (!delivery.delivered) {
      logger.error(
        { event: 'setup_mail_failed', reason: delivery.failure.kind },
        delivery.failure.summary,
      );
    }
  } else {
    await audit.record(db, {
      action: 'installation.bootstrap.failed',
      result: 'denied',
      detail: { stage: 'request_link' },
    });
  }

  // The same words either way. Saying "that is not the configured address"
  // would tell an unauthenticated caller which address owns the installation.
  return {
    status: 'sent',
    message:
      'If that is the address this installation was configured with, a setup link is on its way.',
  };
}

export async function completeSetupAction(
  _previous: SetupFormState,
  form: FormData,
): Promise<SetupFormState> {
  const { db } = runtime();
  const { bootstrap } = identity();

  const token = trimmedField(form, 'token');
  const setupSecret = field(form, 'secret');
  const displayName = trimmedField(form, 'name');

  const metadata = await requestMetadata();

  const result = await bootstrap.complete(db, {
    token,
    setupSecret,
    ...(displayName.length > 0 ? { displayName } : {}),
  });

  if (result.outcome === 'completed') {
    await createAuditRecorder({
      actor: { userId: result.userId, kind: 'user' },
      requestIp: metadata.clientAddress,
      requestUserAgent: metadata.userAgent,
    }).record(db, {
      action: 'installation.bootstrap.completed',
      result: 'success',
      severity: 'notice',
      targetType: 'user',
      targetId: result.userId,
    });

    // Deliberately not signed in. The administrator now exists and signs in
    // through the ordinary flow, which means the very first session on the
    // installation was created the same way every later one will be.
    redirect('/sign-in?setup=complete');
  }

  return {
    status: 'error',
    message:
      result.outcome === 'already_completed'
        ? 'This installation has already been set up. Sign in instead.'
        : 'That link or setup secret is not usable. Check both and try again.',
  };
}
