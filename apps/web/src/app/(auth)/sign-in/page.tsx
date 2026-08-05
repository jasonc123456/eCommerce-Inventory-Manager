import { redirect } from 'next/navigation';

import { identity } from '../../../lib/identity';
import { safeRedirect } from '../../../lib/redirects';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { SignInForm } from './sign-in-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await currentContext();

  if (context !== null) {
    redirect('/');
  }

  // An installation nobody has claimed sends people to setup instead of showing
  // a sign-in form that cannot possibly succeed.
  const status = await identity().bootstrap.status(runtime().db);

  if (status.open) {
    redirect('/setup');
  }

  const params = await searchParams;
  const requested = params['redirect'];
  const redirectPath = safeRedirect(typeof requested === 'string' ? requested : null);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="text-sm opacity-70">
          There is no password. Enter your address and we will send you a way in.
        </p>
      </header>

      <SignInForm redirectPath={redirectPath} />
    </>
  );
}
