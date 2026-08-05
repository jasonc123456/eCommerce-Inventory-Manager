'use client';

import { useActionState } from 'react';

import { requestSignInAction, type SignInFormState } from '../../actions/auth';
import { Button, Field, Notice, TextInput } from '../../../components/form';

/**
 * The sign-in form.
 *
 * A client component only because it renders the outcome of its own submission;
 * the work happens in a server action. It submits without JavaScript too, which
 * matters more than it usually would: this is the screen somebody reaches when
 * something else has already gone wrong.
 *
 * The two methods are one form with two submit buttons rather than a choice the
 * user makes before typing anything. Section 20 lets the user pick either, and
 * asking them to choose a mechanism before they have given an address is asking
 * them to care about something they do not.
 */
export function SignInForm({ redirectPath }: { redirectPath: string }) {
  const [state, action, pending] = useActionState<SignInFormState, FormData>(requestSignInAction, {
    status: 'idle',
  });

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="redirect" value={redirectPath} />

      <Field label="Email address">
        <TextInput
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.email ?? ''}
          aria-describedby={state.status === 'error' ? 'sign-in-message' : undefined}
          aria-invalid={state.status === 'error'}
        />
      </Field>

      {state.message === undefined ? null : (
        <span id="sign-in-message">
          <Notice tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Notice>
        </span>
      )}

      <div className="flex flex-col gap-2">
        <Button type="submit" name="method" value="magic_link" disabled={pending}>
          Email me a sign-in link
        </Button>
        <Button
          type="submit"
          name="method"
          value="email_code"
          variant="secondary"
          disabled={pending}
        >
          Email me a code instead
        </Button>
      </div>
    </form>
  );
}
