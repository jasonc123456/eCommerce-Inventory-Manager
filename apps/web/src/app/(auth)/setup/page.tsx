import { redirect } from 'next/navigation';

import { identity } from '../../../lib/identity';
import { runtime } from '../../../lib/runtime';
import { CompleteSetupForm, RequestSetupLinkForm } from './setup-forms';
import { TOKEN_FIELD } from '../../../lib/token-field';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Set up this installation' };

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const status = await identity().bootstrap.status(runtime().db);

  // Closed permanently once the first administrator exists. Not a redirect for
  // tidiness: an installation that kept serving a setup screen after it was
  // claimed would be inviting somebody to try.
  if (!status.open) {
    redirect('/sign-in');
  }

  const params = await searchParams;
  const step = params['step'];
  const carried = params[TOKEN_FIELD];

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Set up this installation</h1>
        <p className="text-sm text-muted">
          Claiming this installation needs both the configured administrator address and the
          temporary setup secret from its <code>.env</code>. Neither on its own is enough.
        </p>
      </header>

      {step === 'complete' ? (
        <CompleteSetupForm {...(typeof carried === 'string' ? { carriedToken: carried } : {})} />
      ) : (
        <RequestSetupLinkForm />
      )}
    </>
  );
}
