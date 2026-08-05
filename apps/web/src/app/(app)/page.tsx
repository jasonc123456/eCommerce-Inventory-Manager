import { redirect } from 'next/navigation';

import { Card } from '../../components/form';
import { identity } from '../../lib/identity';
import { runtime } from '../../lib/runtime';
import { currentContext } from '../../lib/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Overview' };

/**
 * The signed-in landing page.
 *
 * M1 delivers identity and tenancy, so what this can honestly show is who you
 * are, which businesses you can reach, and what you hold in the one you are
 * looking at. Inventory arrives with the milestones that build it.
 */
export default async function OverviewPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const { memberships } = identity();

  const businesses = await memberships.listBusinessesFor(db, context.user.id);
  const activeId = context.session.activeBusinessId ?? businesses[0]?.businessId ?? null;

  const subject =
    activeId === null ? null : await memberships.loadSubject(db, activeId, context.user.id);

  const active = businesses.find((business) => business.businessId === activeId);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {context.user.displayName ?? context.user.emailDisplay ?? context.user.email}
        </h1>
        <p className="text-sm opacity-70">Signed in as {context.user.email}.</p>
      </header>

      {businesses.length === 0 ? (
        <Card title="No businesses yet">
          <p className="text-sm opacity-80">
            You are not a member of any business. Registration is invitation-only, so somebody who
            already has one has to invite you.
          </p>
        </Card>
      ) : (
        <Card title={active?.name ?? 'Business'}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="opacity-70">Role</dt>
            <dd className="capitalize">{active?.role ?? '—'}</dd>

            <dt className="opacity-70">Permissions</dt>
            <dd>
              {subject === null
                ? '—'
                : subject.isOwner
                  ? 'Every permission, as the owner'
                  : `${String(subject.grants.length)} granted`}
            </dd>

            <dt className="opacity-70">Businesses</dt>
            <dd>{businesses.length}</dd>
          </dl>
        </Card>
      )}

      <Card title="What is here so far">
        <p className="text-sm opacity-80">
          Identity and tenancy: sign-in, invitations, roles and permissions, passkeys, second
          factors, sessions, and the audit trail. Catalogue, mapping, and inventory follow in the
          next milestones.
        </p>
      </Card>
    </main>
  );
}
