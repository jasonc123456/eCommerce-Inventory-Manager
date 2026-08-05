'use client';

import { useActionState } from 'react';

import {
  completeSetupAction,
  requestSetupLinkAction,
  type SetupFormState,
} from '../../actions/setup';
import { Button, Field, Notice, TextInput } from '../../../components/form';
import { useFragmentSecret } from '../../../components/use-fragment-secret';

/** Step one: ask for the one-time link. */
export function RequestSetupLinkForm() {
  const [state, action, pending] = useActionState<SetupFormState, FormData>(
    requestSetupLinkAction,
    { status: 'idle' },
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label="Administrator email"
        hint="The address in EIM_INITIAL_ADMIN_EMAIL on the deployment host."
      >
        <TextInput
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </Field>

      {state.message === undefined ? null : (
        <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>
      )}

      <Button type="submit" disabled={pending}>
        Send the setup link
      </Button>
    </form>
  );
}

/**
 * Step two: the link's token plus the setup secret.
 *
 * The token arrives in the fragment, exactly as a sign-in link does, and is
 * cleared from the address bar as soon as it has been read.
 */
export function CompleteSetupForm() {
  const fragment = useFragmentSecret();
  const [state, action, pending] = useActionState<SetupFormState, FormData>(completeSetupAction, {
    status: 'idle',
  });

  if (fragment === undefined) {
    return <p className="text-sm opacity-70">Checking your link…</p>;
  }

  if (fragment.length === 0) {
    return (
      <Notice tone="error">
        This link is missing its setup token. Open the most recent message, or request another.
      </Notice>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={fragment} />

      <Field
        label="Setup secret"
        hint="EIM_SETUP_SECRET from the deployment host. Remove it from .env once this is done."
      >
        <TextInput name="secret" type="password" autoComplete="off" required />
      </Field>

      <Field label="Your name" hint="Optional. Shown on audit entries and member lists.">
        <TextInput name="name" autoComplete="name" />
      </Field>

      {state.message === undefined ? null : <Notice tone="error">{state.message}</Notice>}

      <Button type="submit" disabled={pending}>
        Create the first administrator
      </Button>
    </form>
  );
}
