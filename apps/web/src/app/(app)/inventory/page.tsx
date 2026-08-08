import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, Notice } from '../../../components/form';
import { csrfToken } from '../../../lib/csrf';
import { identity } from '../../../lib/identity';
import { inventoryPermissions, loadOverview } from '../../../lib/inventory';
import { runtime } from '../../../lib/runtime';
import { currentContext } from '../../../lib/session';
import { CreateItemForm, SettingsForm } from './inventory-forms';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Inventory' };

/**
 * The canonical items this business holds stock of (sections 8, 9, 21).
 *
 * Every number on this page comes from the canonical ledger. Nothing is read
 * from a provider, and nothing on this page writes to one — which is what lets
 * it render during exactly the outage somebody would open it to understand.
 *
 * The page hides what the caller cannot do, and every action re-checks it
 * server-side anyway. Section 5: hiding a control is a courtesy to the person
 * using the screen, not a control on the person attacking it.
 */
export default async function InventoryPage() {
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
        <h1 className="text-xl font-semibold">Inventory</h1>
        <Notice tone="info">You are not a member of any business yet.</Notice>
      </main>
    );
  }

  const permissions = await inventoryPermissions(db, businessId, context.user.id);

  if (!permissions.viewInventory) {
    return (
      <main className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold">Inventory</h1>
        <Notice tone="info">You do not have permission to view inventory in this business.</Notice>
      </main>
    );
  }

  const { settings, locations, items } = await loadOverview(businessId);
  const csrf = csrfToken(context.session);

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Inventory</h1>
        <nav className="flex gap-4 text-sm">
          <Link className="underline" href="/inventory/locations">
            Locations
          </Link>
          <Link className="underline" href="/mappings">
            Mappings
          </Link>
        </nav>
      </header>

      <Card title="Rules">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-neutral-500">Default safety stock</dt>
          <dd>
            {settings.defaultSafetyStock} unit{settings.defaultSafetyStock === 1 ? '' : 's'}{' '}
            withheld per location
          </dd>
          <dt className="text-neutral-500">Consumption mode</dt>
          <dd>
            {settings.consumptionMode === 'reserve_until_fulfilled'
              ? 'Reserve until fulfilled'
              : 'Consume immediately'}
          </dd>
          <dt className="text-neutral-500">Split fulfillment</dt>
          <dd>{settings.splitFulfillment ? 'One order may draw on several locations' : 'Off'}</dd>
        </dl>
        {permissions.manageRules ? (
          <SettingsForm csrf={csrf} businessId={businessId} settings={settings} />
        ) : null}
      </Card>

      <Card title={`Items (${String(items.length)})`}>
        {items.length === 0 ? (
          <p className="text-sm text-neutral-600">
            No canonical items yet. An item is the unit of truth for stock; channel listings project
            from it, never the other way round.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 text-sm">
            {items.map((item) => (
              <li key={item.id} className="flex items-baseline justify-between gap-4 py-2">
                <Link className="underline" href={`/inventory/${item.id}`}>
                  {item.sku}
                </Link>
                <span className="flex-1 text-neutral-600">{item.name}</span>
                <span className="text-neutral-500">
                  {item.safetyStockOverride === null
                    ? 'inherits safety stock'
                    : `withholds ${String(item.safetyStockOverride)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {permissions.manageRules ? <CreateItemForm csrf={csrf} businessId={businessId} /> : null}
      </Card>

      {locations.length === 0 ? (
        <Notice tone="info">
          There are no locations yet. Stock has to sit somewhere before it can be counted — add one
          on the locations page.
        </Notice>
      ) : null}
    </main>
  );
}
