import Link from 'next/link';

import { safeRedirect } from '../../../../lib/redirects';
import { LinkForm } from './link-form';
import { TOKEN_FIELD } from '../../../../lib/token-field';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Confirm sign-in' };

export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = params['redirect'];
  // D-182: the query carrier, for installations whose mail gateway rewrites
  // links and drops the fragment. Reading it here does not spend it — nothing is
  // verified until the button below is pressed.
  const carried = params[TOKEN_FIELD];

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Confirm sign-in</h1>
        <p className="text-sm opacity-70">
          Press the button to finish signing in on this device. The extra press is what stops a mail
          scanner from using the link before you do.
        </p>
      </header>

      <LinkForm
        redirectPath={safeRedirect(typeof requested === 'string' ? requested : null)}
        {...(typeof carried === 'string' ? { carriedToken: carried } : {})}
      />

      <p className="text-sm opacity-70">
        Did not expect this?{' '}
        <Link href="/sign-in" className="underline">
          Ignore it and start again
        </Link>
        .
      </p>
    </>
  );
}
