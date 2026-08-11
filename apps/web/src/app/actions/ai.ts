'use server';

import {
  AiConfigurationError,
  configureProvider,
  removeProvider,
  setProviderEnabled,
  testProvider,
} from '@eim/ai';
import type { AiProviderKind } from '@eim/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ai } from '../../lib/ai';
import { assertCsrf } from '../../lib/csrf';
import { field, trimmedField } from '../../lib/forms';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';
import { integrationUrlPolicy } from '../../lib/woocommerce';

/**
 * Configuring optional AI from a browser (sections 18, 19, 20).
 *
 * Four actions and no fifth. Configuring, testing, switching on or off, and
 * removing are all decisions about this installation's own records; asking a
 * question is not here because it belongs to the screen doing the work, and
 * publishing is not here because nothing in this milestone publishes anything.
 *
 * The credential is write-only from the browser's point of view. It arrives in a
 * form, goes to the encrypted store, and is never read back — the settings
 * screen shows whether a key exists, never any part of one, which is section
 * 19's "masked after entry, never returned to the browser".
 */

export interface AiFormState {
  readonly status: 'idle' | 'done' | 'error';
  readonly message?: string;
  readonly reason?: string;
}

export async function configureAiAction(
  _previous: AiFormState,
  form: FormData,
): Promise<AiFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  const apiKey = trimmedField(form, 'apiKey');
  const kind = field(form, 'kind') === 'ollama' ? 'ollama' : 'openai_compatible';

  try {
    await configureProvider(db, ai().secrets, context.audit, {
      businessId,
      kind: kind satisfies AiProviderKind,
      baseUrl: trimmedField(form, 'baseUrl'),
      model: trimmedField(form, 'model'),
      subject,
      actorUserId: context.user.id,
      hasRecentAuthentication: identity().sessions.hasRecentAuthentication(context.session),
      urlPolicy: integrationUrlPolicy(),
      // An empty box means "leave the stored key alone", never "delete it". A
      // form that cleared a working credential because somebody edited the model
      // name would be a trap.
      ...(apiKey === '' ? {} : { apiKey }),
      ...numeric(form, 'requestTimeoutMs'),
      ...numeric(form, 'maxOutputTokens'),
      ...numeric(form, 'monthlyRequestCap'),
      ...numeric(form, 'monthlyTokenCap'),
      imageAnalysisEnabled: field(form, 'imageAnalysisEnabled') === 'on',
      retainPrompts: field(form, 'retainPrompts') === 'on',
      ...money(form, 'costCurrency'),
      ...money(form, 'costPerMillionInputTokens'),
      ...money(form, 'costPerMillionOutputTokens'),
      ...money(form, 'monthlyCostCapAmount'),
    });
  } catch (error) {
    return failed(error);
  }

  revalidatePath('/ai');

  return {
    status: 'done',
    message: 'Saved, switched off, and unchecked. Test it, then switch it on.',
  };
}

export async function testAiAction(_previous: AiFormState, form: FormData): Promise<AiFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  let result: { readonly ready: boolean; readonly summary: string };

  try {
    result = await testProvider(db, context.audit, ai().adapterFor(businessId), {
      businessId,
      subject,
      urlPolicy: integrationUrlPolicy(),
    });
  } catch (error) {
    return failed(error);
  }

  revalidatePath('/ai');

  return result.ready
    ? { status: 'done', message: `The endpoint answered as ${result.summary}.` }
    : { status: 'error', message: `The endpoint did not answer: ${result.summary}` };
}

export async function setAiEnabledAction(
  _previous: AiFormState,
  form: FormData,
): Promise<AiFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);
  const enabled = field(form, 'enabled') === 'true';

  try {
    await setProviderEnabled(db, context.audit, { businessId, enabled, subject });
  } catch (error) {
    return failed(error);
  }

  revalidatePath('/ai');

  return {
    status: 'done',
    message: enabled
      ? 'Switched on. Suggestions still have to be asked for, and reviewed.'
      : 'Switched off. Nothing will be sent anywhere.',
  };
}

export async function removeAiAction(_previous: AiFormState, form: FormData): Promise<AiFormState> {
  const { db } = runtime();
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const businessId = field(form, 'businessId');
  const subject = await identity().memberships.loadSubject(db, businessId, context.user.id);

  if (subject === null) {
    return { status: 'error', message: 'You are not a member of that business.' };
  }

  assertCsrf(form, context.session);

  try {
    await removeProvider(db, ai().secrets, context.audit, { businessId, subject });
  } catch (error) {
    return failed(error);
  }

  revalidatePath('/ai');

  return {
    status: 'done',
    message: 'Removed, and the key destroyed. What was already suggested is still recorded.',
  };
}

function failed(error: unknown): AiFormState {
  if (error instanceof AiConfigurationError) {
    return { status: 'error', message: error.message, reason: error.reason };
  }

  throw error;
}

/** A whole number a form supplied, or nothing at all when it left the box empty. */
function numeric(form: FormData, name: string): Record<string, number> | object {
  const raw = trimmedField(form, name);

  if (raw === '') {
    return {};
  }

  const value = Number(raw);

  return Number.isSafeInteger(value) && value > 0 ? { [name]: value } : {};
}

/**
 * A money value, kept as the string it was typed as.
 *
 * An empty box clears the setting rather than leaving it, which is the opposite
 * of the credential rule above and is right for the same reason: clearing a
 * price nobody is paying any more is what somebody means by emptying the box,
 * while clearing a credential by editing an unrelated field is not.
 */
function money(form: FormData, name: string): Record<string, string | null> {
  const raw = trimmedField(form, name);

  return { [name]: raw === '' ? null : raw };
}
