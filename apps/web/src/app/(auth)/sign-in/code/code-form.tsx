'use client';

import { useActionState } from 'react';

import { verifyCodeAction, type VerifyFormState } from '../../../actions/auth';
import { Button, Field, Notice, TextInput } from '../../../../components/form';

/**
 * The eight-digit code entry.
 *
 * One input rather than eight boxes. Section 20 requires paste to work, one
 * logical value, and accessible focus and error behaviour, and the split-box
 * pattern fights all three: it breaks paste on several browsers, announces
 * itself to a screen reader as eight unlabelled fields, and moves focus in ways
 * nobody asked for.
 *
 * `inputMode="numeric"` brings up the number pad on a phone without making the
 * field a `type="number"`, which would strip the leading zero that one code in
 * ten starts with.
 */
export function CodeForm({ redirectPath }: { redirectPath: string }) {
  const [state, action, pending] = useActionState<VerifyFormState, FormData>(verifyCodeAction, {
    status: 'idle',
  });

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="redirect" value={redirectPath} />

      <Field label="Eight-digit code" hint="It expires ten minutes after it was sent.">
        <TextInput
          name="code"
          inputMode="numeric"
          pattern="[0-9 ]*"
          autoComplete="one-time-code"
          maxLength={12}
          required
          className="text-center font-mono text-2xl tracking-[0.3em]"
          aria-describedby={state.status === 'error' ? 'code-message' : undefined}
          aria-invalid={state.status === 'error'}
        />
      </Field>

      {state.message === undefined ? null : (
        <span id="code-message">
          <Notice tone="error">{state.message}</Notice>
        </span>
      )}

      <Button type="submit" disabled={pending}>
        Sign in
      </Button>
    </form>
  );
}
