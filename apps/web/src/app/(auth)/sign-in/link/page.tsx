import Link from 'next/link';

import { safeRedirect } from '../../../../lib/redirects';
import { LinkForm } from './link-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Confirm sign-in' };

export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = params['redirect'];

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Confirm sign-in</h1>
        <p className="text-sm opacity-70">
          Press the button to finish signing in on this device. The extra press is what stops a mail
          scanner from using the link before you do.
        </p>
      </header>

      <LinkForm redirectPath={safeRedirect(typeof requested === 'string' ? requested : null)} />

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
