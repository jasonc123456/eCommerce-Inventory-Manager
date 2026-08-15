'use client';

import { useActionState } from 'react';

import {
  activateTotpAction,
  beginTotpEnrollmentAction,
  disableTotpAction,
  regenerateRecoveryCodesAction,
  type SecurityFormState,
} from '../../../actions/account';
import { Button, Card, Field, Notice, TextInput } from '../../../../components/form';
import { CSRF_FIELD } from '../../../../lib/csrf-field';

/**
 * The second-factor panels.
 *
 * The recovery codes are rendered here and nowhere else, and only in the
 * response to the action that created them. Section 20 shows them once; storing
 * them anywhere else so a later page could display them would make "once" a
 * description of the UI rather than a property of the system.
 */
export function TotpPanel({
  csrf,
  active,
  remainingRecoveryCodes,
}: {
  csrf: string;
  active: boolean;
  remainingRecoveryCodes: number;
}) {
  const [enrollState, enroll, enrolling] = useActionState<SecurityFormState, FormData>(
    beginTotpEnrollmentAction,
    { status: 'idle' },
  );
  const [activateState, activate, activating] = useActionState<SecurityFormState, FormData>(
    activateTotpAction,
    { status: 'idle' },
  );
  const [disableState, disable, disabling] = useActionState<SecurityFormState, FormData>(
    disableTotpAction,
    { status: 'idle' },
  );
  const [codesState, regenerate, regenerating] = useActionState<SecurityFormState, FormData>(
    regenerateRecoveryCodesAction,
    { status: 'idle' },
  );

  const freshCodes =
    activateState.status === 'codes'
      ? activateState.codes
      : codesState.status === 'codes'
        ? codesState.codes
        : null;

  if (active) {
    return (
      <>
        <Card title="Two-factor authentication">
          <p className="text-sm text-muted">
            On. Signing in needs your authenticator as well as your email, and a message to your
            inbox does not count as the second factor.
          </p>
          <p className="text-sm text-muted">
            {remainingRecoveryCodes} recovery {remainingRecoveryCodes === 1 ? 'code' : 'codes'}{' '}
            unused.
          </p>

          <form action={regenerate} className="flex flex-col gap-3">
            <input type="hidden" name={CSRF_FIELD} value={csrf} />
            {codesState.status === 'error' ? (
              <Notice tone="error">{codesState.message}</Notice>
            ) : null}
            <Button type="submit" variant="secondary" disabled={regenerating}>
              Generate a new set of recovery codes
            </Button>
          </form>
        </Card>

        {freshCodes === null ? null : <RecoveryCodes codes={freshCodes} />}

        <Card title="Turn two-factor authentication off">
          <form action={disable} className="flex flex-col gap-3">
            <input type="hidden" name={CSRF_FIELD} value={csrf} />
            <Field
              label="Current authenticator code or recovery code"
              hint="Recent sign-in alone is not enough to remove the factor protecting the account."
            >
              <TextInput name="proof" autoComplete="one-time-code" required className="font-mono" />
            </Field>
            {disableState.status === 'error' ? (
              <Notice tone="error">{disableState.message}</Notice>
            ) : null}
            {disableState.status === 'done' ? (
              <Notice tone="info">{disableState.message}</Notice>
            ) : null}
            <Button type="submit" variant="secondary" disabled={disabling}>
              Turn it off
            </Button>
          </form>
        </Card>
      </>
    );
  }

  return (
    <>
      <Card title="Two-factor authentication">
        <p className="text-sm text-muted">
          Off. Adding an authenticator means a stolen inbox is no longer enough to reach your
          account.
        </p>

        {enrollState.status === 'enrolling' ? (
          <form action={activate} className="flex flex-col gap-3">
            <input type="hidden" name={CSRF_FIELD} value={csrf} />

            <p className="text-sm text-muted">
              Add this to your authenticator, then enter the code it shows.
            </p>
            <p className="rounded-md bg-black/5 p-3 font-mono text-sm break-all dark:bg-white/10">
              {enrollState.manualEntryKey}
            </p>
            <p className="text-xs text-muted">
              Or open this URI in your authenticator:{' '}
              <span className="font-mono break-all">{enrollState.otpauthUri}</span>
            </p>

            <Field label="Code from your authenticator">
              <TextInput
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                className="font-mono"
              />
            </Field>

            {activateState.status === 'error' ? (
              <Notice tone="error">{activateState.message}</Notice>
            ) : null}

            <Button type="submit" disabled={activating}>
              Turn it on
            </Button>
          </form>
        ) : (
          <form action={enroll} className="flex flex-col gap-3">
            <input type="hidden" name={CSRF_FIELD} value={csrf} />
            {enrollState.status === 'error' ? (
              <Notice tone="error">{enrollState.message}</Notice>
            ) : null}
            <Button type="submit" disabled={enrolling}>
              Set up an authenticator
            </Button>
          </form>
        )}
      </Card>

      {freshCodes === null ? null : <RecoveryCodes codes={freshCodes} />}
    </>
  );
}

function RecoveryCodes({ codes }: { codes: readonly string[] }) {
  return (
    <Card title="Save these recovery codes now">
      <p className="text-sm text-muted">
        Each works once, and this is the only time they are shown. They are the way back in if you
        lose your authenticator.
      </p>
      <ul className="grid grid-cols-1 gap-1 font-mono text-sm sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </Card>
  );
}
