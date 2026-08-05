'use client';

import { useActionState } from 'react';

import { verifyLinkAction, type VerifyFormState } from '../../../actions/auth';
import { Button, Notice } from '../../../../components/form';
import { useFragmentSecret } from '../../../../components/use-fragment-secret';

/**
 * The magic-link confirmation (sections 19, 20).
 *
 * Two rules meet on this screen.
 *
 * The secret is in the URL fragment, not the query. A fragment is never sent in
 * an HTTP request, so it does not appear in the server's access log, the reverse
 * proxy's log, or a Referer header — which is where a token in a query string
 * ends up, in plain text, on several machines.
 *
 * The initial GET must not authenticate. Mail scanners, link previewers, and
 * corporate security gateways all fetch links in messages, and a link that
 * signed you in on GET would be spent by a machine before the recipient saw it.
 * So the fragment is read here and posted back only when somebody presses the
 * button.
 */
export function LinkForm({ redirectPath }: { redirectPath: string }) {
  const fragment = useFragmentSecret();
  const [state, action, pending] = useActionState<VerifyFormState, FormData>(verifyLinkAction, {
    status: 'idle',
  });

  if (fragment === undefined) {
    return <p className="text-sm opacity-70">Checking your link…</p>;
  }

  if (fragment.length === 0) {
    return (
      <Notice tone="error">
        This link is missing its sign-in token. Open the most recent message, or request a new one.
      </Notice>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={fragment} />
      <input type="hidden" name="redirect" value={redirectPath} />

      {state.message === undefined ? null : <Notice tone="error">{state.message}</Notice>}

      <Button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Confirm sign-in'}
      </Button>
    </form>
  );
}
