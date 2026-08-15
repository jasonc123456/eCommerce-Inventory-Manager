import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../components/form';
import { csrfToken } from '../../../lib/csrf';
import { identity } from '../../../lib/identity';
import { inventoryPermissions, loadMappings } from '../../../lib/inventory';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { MappingControls } from './mapping-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Mappings' };

/**
 * What each canonical item is sold as, and whether it is synchronizing
 * (sections 6, 7, 21).
 *
 * A mapping is the thing that lets this application change what a customer sees,
 * so the screen leads with the state rather than with the pairing: a mapping can
 * be perfectly well formed and still be writing nothing, because it is
 * unapproved, paused, ineligible, or waiting on a sibling variation.
 *
 * Nothing on this page contacts a provider. Activating a mapping makes future
 * writes permitted; it does not perform one.
 */
export default async function MappingsPage() {
  const context = await currentContext();

  if (context === null) {
    redirect('/sign-in');
  }

  const { db } = runtime();
  const businesses = await identity().memberships.listBusinessesFor(db, context.user.id);
  const businessId = context.session.activeBusinessId ?? businesses[0]?.businessId ?? null;

  if (businessId === null) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Mappings</h1>
        <Notice tone="info">You are not a member of any business yet.</Notice>
      </main>
    );
  }

  const permissions = await inventoryPermissions(db, businessId, context.user.id);

  if (!permissions.viewMappings) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Mappings</h1>
        <Notice tone="info">You do not have permission to view mappings in this business.</Notice>
      </main>
    );
  }

  const grouped = await loadMappings(businessId);
  const csrf = csrfToken(context.session);
  const total = grouped.reduce((count, group) => count + group.mappings.length, 0);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Mappings</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/inventory">
            Inventory
          </Link>
          <Link className="underline" href="/connections">
            Connections
          </Link>
        </nav>
      </header>

      {grouped.length === 0 ? (
        <Notice tone="info">
          No provider is connected yet. A mapping needs an imported channel entity to point at.
        </Notice>
      ) : null}

      {total === 0 && grouped.length > 0 ? (
        <Notice tone="info">
          Nothing is mapped yet. Importing a catalog records what a provider sells; mapping is the
          separate, approved decision about which canonical item each of those is.
        </Notice>
      ) : null}

      {grouped.map((group) => (
        <Card key={group.connectionId} title={`${group.displayName} (${group.provider})`}>
          {group.mappings.length === 0 ? (
            <p className="text-sm text-neutral-600">Nothing from this connection is mapped.</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {group.mappings.map((mapping) => (
                <li
                  key={mapping.id}
                  className="flex flex-col gap-2 border-t border-neutral-200 pt-3"
                >
                  <div className="flex flex-wrap items-baseline gap-3 text-sm">
                    <span className="font-mono">{mapping.externalId}</span>
                    <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs uppercase">
                      {mapping.status}
                    </span>
                    <span className="text-neutral-500">version {mapping.version}</span>
                    {mapping.channelCap === null ? null : (
                      <span className="text-neutral-500">cap {mapping.channelCap}</span>
                    )}
                    {mapping.channelBuffer === 0 ? null : (
                      <span className="text-neutral-500">buffer {mapping.channelBuffer}</span>
                    )}
                  </div>

                  {mapping.pauseReason === null ? null : (
                    <p className="text-sm text-[var(--warn)]">{mapping.pauseReason}</p>
                  )}
                  {mapping.inventoryEligible ? null : (
                    <p className="text-sm text-[var(--warn)]">
                      {mapping.ineligibleReason ??
                        'this channel entity cannot be synchronized in version 1'}
                    </p>
                  )}

                  <MappingControls
                    csrf={csrf}
                    businessId={businessId}
                    mappingId={mapping.id}
                    status={mapping.status}
                    mayApprove={permissions.approveMappings}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </main>
  );
}
