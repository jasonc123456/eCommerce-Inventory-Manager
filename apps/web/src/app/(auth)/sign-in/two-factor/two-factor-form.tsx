'use client';

import { useActionState, useState } from 'react';

import { verifySecondFactorAction, type VerifyFormState } from '../../../actions/auth';
import { Button, Field, Notice, TextInput } from '../../../../components/form';

/**
 * The second factor.
 *
 * Both routes in are on one screen, because the moment somebody needs the
 * recovery code is the moment their authenticator is unavailable — and making
 * them hunt for a separate page in that state is the worst possible time to
 * charge them a navigation.
 */
export function TwoFactorForm() {
  const [usingRecovery, setUsingRecovery] = useState(false);
  const [state, action, pending] = useActionState<VerifyFormState, FormData>(
    verifySecondFactorAction,
    { status: 'idle' },
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="kind" value={usingRecovery ? 'recovery' : 'totp'} />

      {usingRecovery ? (
        <Field label="Recovery code" hint="One of the ten you saved when you set this up.">
          <TextInput
            name="code"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            required
            className="font-mono"
            aria-invalid={state.status === 'error'}
          />
        </Field>
      ) : (
        <Field label="Authenticator code" hint="Six digits from your authenticator app.">
          <TextInput
            name="code"
            inputMode="numeric"
            pattern="[0-9 ]*"
            autoComplete="one-time-code"
            maxLength={8}
            required
            className="text-center font-mono text-2xl tracking-[0.3em]"
            aria-invalid={state.status === 'error'}
          />
        </Field>
      )}

      {state.message === undefined ? null : <Notice tone="error">{state.message}</Notice>}

      <Button type="submit" disabled={pending}>
        Continue
      </Button>

      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setUsingRecovery((current) => !current);
        }}
      >
        {usingRecovery ? 'Use my authenticator instead' : 'Use a recovery code instead'}
      </Button>
    </form>
  );
}
