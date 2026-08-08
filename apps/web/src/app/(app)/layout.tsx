import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { signOutAction } from '../actions/auth';
import { switchBusinessAction } from '../actions/account';
import { csrfToken } from '../../lib/csrf';
import { CSRF_FIELD } from '../../lib/csrf-field';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * The shell for every signed-in screen.
 *
 * The session is resolved here, once, and every page below inherits the
 * guarantee that there is one. A page that needed to reason about being signed
 * out would be a page that could get it wrong.
 */
export default async function ApplicationLayout({ children }: { children: ReactNode }) {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const businesses = await identity().memberships.listBusinessesFor(db, context.user.id);
  const token = csrfToken(context.session);

  const active =
    businesses.find((business) => business.businessId === context.session.activeBusinessId) ??
    businesses[0];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-black/10 pb-4 dark:border-white/15">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-base font-semibold">
            Inventory Manager
          </Link>

          {businesses.length === 0 ? null : (
            <form action={switchBusinessAction} className="flex items-center gap-2">
              <input type="hidden" name={CSRF_FIELD} value={token} />
              <label htmlFor="business-switcher" className="sr-only">
                Business
              </label>
              {/* Submits on change for a pointer, and the button is there for
                  keyboard and no-JavaScript use. Section 21 needs both. */}
              <select
                id="business-switcher"
                name="businessId"
                defaultValue={active?.businessId ?? ''}
                className="rounded-md border border-black/20 bg-transparent px-2 py-1 text-sm dark:border-white/25"
              >
                {businesses.map((business) => (
                  <option key={business.businessId} value={business.businessId}>
                    {business.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="text-sm underline">
                Switch
              </button>
            </form>
          )}
        </div>

        <nav className="flex items-center gap-4 text-sm">
          <Link href="/inventory" className="underline">
            Inventory
          </Link>
          <Link href="/mappings" className="underline">
            Mappings
          </Link>
          <Link href="/operations" className="underline">
            Drafts and prices
          </Link>
          <Link href="/connections" className="underline">
            Connections
          </Link>
          <Link href="/members" className="underline">
            Members
          </Link>
          <Link href="/account/sessions" className="underline">
            Devices
          </Link>
          <Link href="/account/security" className="underline">
            Security
          </Link>
          <form action={signOutAction}>
            <input type="hidden" name={CSRF_FIELD} value={token} />
            <button type="submit" className="underline">
              Sign out
            </button>
          </form>
        </nav>
      </header>

      {children}
    </div>
  );
}
