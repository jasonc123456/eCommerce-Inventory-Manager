import { redirect } from 'next/navigation';

import { readPendingAuthentication } from '../../../../lib/pending';
import { TwoFactorForm } from './two-factor-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Second factor' };

export default async function TwoFactorPage() {
  // Reaching this page without having passed the email factor means the pending
  // cookie is missing or expired, and there is nothing to continue.
  if ((await readPendingAuthentication()) === null) {
    redirect('/sign-in');
  }

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">One more step</h1>
        <p className="text-sm opacity-70">
          Your account has a second factor. Email alone does not sign you in.
        </p>
      </header>

      <TwoFactorForm />
    </>
  );
}
