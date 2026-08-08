import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../../components/form';
import { csrfToken } from '../../../../lib/csrf';
import { identity } from '../../../../lib/identity';
import { inventoryPermissions, loadOverview } from '../../../../lib/inventory';
import { runtime } from '../../../../lib/runtime';
import { currentContext } from '../../../../lib/session';
import { LocationForms } from '../inventory-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Locations' };

/**
 * The places stock physically sits (section 9).
 *
 * Locations are real pools, not tags. Two consequences show up on this screen:
 * the priority decides which one an order is allocated from, and a location
 * holding units cannot be archived — archiving it would leave those units
 * counted in no pool and reachable through no screen.
 */
export default async function LocationsPage() {
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
        <h1 className="text-xl font-semibold">Locations</h1>
        <Notice tone="info">You are not a member of any business yet.</Notice>
      </main>
    );
  }

  const permissions = await inventoryPermissions(db, businessId, context.user.id);

  if (!permissions.viewInventory) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Locations</h1>
        <Notice tone="info">You do not have permission to view inventory in this business.</Notice>
      </main>
    );
  }

  const { locations } = await loadOverview(businessId);
  const csrf = csrfToken(context.session);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link className="text-sm underline" href="/inventory">
          Inventory
        </Link>
        <h1 className="text-xl font-semibold">Locations</h1>
      </header>

      <Card title={`Locations (${String(locations.length)})`}>
        {locations.length === 0 ? (
          <p className="text-sm text-neutral-600">
            No locations yet. Stock has to sit somewhere before it can be counted.
          </p>
        ) : (
          <ul className="mb-4 flex flex-col divide-y divide-neutral-200 text-sm">
            {locations.map((location) => (
              <li key={location.id} className="flex flex-wrap items-baseline gap-3 py-2">
                <span className="font-mono">{location.code}</span>
                <span className="flex-1">{location.name}</span>
                <span className="text-neutral-500">priority {location.priority}</span>
                <span className="text-neutral-500">
                  {location.isActive ? 'active' : 'inactive'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {permissions.manageLocations ? (
          <LocationForms csrf={csrf} businessId={businessId} locations={locations} />
        ) : (
          <Notice tone="info">You cannot change locations in this business.</Notice>
        )}
      </Card>
    </main>
  );
}
