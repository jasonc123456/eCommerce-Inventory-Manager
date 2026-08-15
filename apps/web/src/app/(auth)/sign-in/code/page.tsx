import Link from 'next/link';

import { safeRedirect } from '../../../../lib/redirects';
import { CodeForm } from './code-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Enter your code' };

export default async function CodePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = params['redirect'];

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Enter your code</h1>
        <p className="text-sm text-muted">
          If that address has an account, an eight-digit code is on its way.
        </p>
      </header>

      <CodeForm redirectPath={safeRedirect(typeof requested === 'string' ? requested : null)} />

      <p className="text-sm text-muted">
        <Link href="/sign-in" className="underline">
          Start again
        </Link>{' '}
        if the code has expired or you did not receive one.
      </p>
    </>
  );
}
