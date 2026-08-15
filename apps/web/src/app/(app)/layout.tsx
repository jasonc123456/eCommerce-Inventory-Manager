import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AppSidebar, AppTopBar, type BusinessOption } from '../../components/app-sidebar';
import { csrfToken } from '../../lib/csrf';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';
import { switchBusinessAction } from '../actions/account';
import { signOutAction } from '../actions/auth';

export const dynamic = 'force-dynamic';

/**
 * The shell for every signed-in screen.
 *
 * The session is resolved here, once, and every page below inherits the
 * guarantee that there is one. A page that needed to reason about being signed
 * out would be a page that could get it wrong.
 *
 * The sidebar is rendered twice — a persistent panel from the medium breakpoint
 * up, and a drawer below it — with one set of props. That is deliberate
 * duplication of markup rather than of decisions: both read the same list, the
 * same active business, and the same actions, so the two cannot drift into
 * disagreeing about what exists.
 */
export default async function ApplicationLayout({ children }: { children: ReactNode }) {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const memberships = await identity().memberships.listBusinessesFor(db, context.user.id);
  const token = csrfToken(context.session);

  const businesses: readonly BusinessOption[] = memberships.map((membership) => ({
    businessId: membership.businessId,
    name: membership.name,
    role: membership.role,
  }));

  const active =
    businesses.find((business) => business.businessId === context.session.activeBusinessId) ??
    businesses[0];

  const sidebar = {
    businesses,
    activeBusinessId: active?.businessId ?? null,
    userEmail: context.user.email,
    csrf: token,
    switchAction: switchBusinessAction,
    signOutAction,
  };

  return (
    <div className="flex min-h-dvh w-full">
      {/* WCAG 2.4.1. The sidebar is the first thing in the document and holds
          fifteen links; without this, reaching the content by keyboard means
          tabbing past all of them on every page. Visible only when focused, so
          it costs a pointer user nothing. */}
      <a
        href="#main"
        className="btn-primary sr-only rounded-lg px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Skip to content
      </a>

      <AppSidebar {...sidebar} />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopBar {...sidebar} />

        {/* A target rather than the landmark itself: each page renders its own
            `<main>`, and two nested ones would be invalid. `tabIndex={-1}` makes
            this focusable by the skip link without putting it in the tab order. */}
        <div
          id="main"
          tabIndex={-1}
          className="mx-auto flex w-full max-w-5xl flex-1 flex-col p-4 sm:p-6 lg:p-8"
        >
          {children}
        </div>
      </div>
    </div>
  );
}
